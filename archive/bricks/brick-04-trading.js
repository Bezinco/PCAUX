// archive/bricks/brick-04-trading.js
// PCAux Diamond Platform - Brick #4: Trading Market (Vercel/Supabase)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const PREGRADE_DAYS_DEFAULT = 30;
const MAKER_FEE_BPS = 25;
const TAKER_FEE_BPS = 50;

// ===== ORDER MANAGEMENT =====

export async function placeOrder(req, res) {
  const { diamondId } = req.params;
  const { side, price, quantity, order_type = 'limit' } = req.body;
  const userId = req.user.id;

  try {
    // Verify diamond is in trading window
    const { data: diamond } = await supabase
      .from('diamonds')
      .select(`
        *,
        ipos!inner(ipo_price, total_pcus, sold_pcus, closes_at as ipo_closed_at)
      `)
      .eq('id', diamondId)
      .eq('status', 'listing')
      .single();

    if (!diamond) {
      return res.status(404).json({ error: 'Diamond not in trading window' });
    }

    // Check trading window
    const ipoClosed = new Date(diamond.ipos.ipo_closed_at);
    const windowEnd = new Date(ipoClosed);
    windowEnd.setDate(windowEnd.getDate() + PREGRADE_DAYS_DEFAULT);

    if (new Date() > windowEnd) {
      return res.status(400).json({ 
        error: 'Pre-grade trading window closed',
        window_closed_at: windowEnd
      });
    }

    // For sell orders: verify PCU holdings
    if (side === 'sell') {
      const { data: holding } = await supabase
        .from('pcu_balances')
        .select('quantity')
        .eq('user_id', userId)
        .eq('diamond_id', diamondId)
        .single();

      const available = holding?.quantity || 0;

      // Check pending sell orders
      const { data: pending } = await supabase
        .from('orders')
        .select('quantity, filled_quantity')
        .eq('user_id', userId)
        .eq('diamond_id', diamondId)
        .eq('side', 'sell')
        .in('status', ['open', 'partial']);

      const pendingQty = pending?.reduce((sum, o) => sum + (o.quantity - o.filled_quantity), 0) || 0;
      const availableAfterPending = available - pendingQty;

      if (quantity > availableAfterPending) {
        return res.status(400).json({
          error: 'Insufficient PCUs',
          available: availableAfterPending,
          requested: quantity
        });
      }
    }

    // For buy orders: verify USD balance
    if (side === 'buy') {
      const totalCost = price * quantity;
      const { data: balance } = await supabase
        .from('user_balances')
        .select('balance')
        .eq('user_id', userId)
        .single();

      if (!balance || balance.balance < totalCost) {
        return res.status(402).json({
          error: 'Insufficient balance',
          required: totalCost,
          available: balance?.balance || 0
        });
      }

      // Reserve balance
      await supabase
        .from('user_balances')
        .update({ 
          balance: balance.balance - totalCost, 
          reserved: (balance.reserved || 0) + totalCost,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);
    }

    // Create order
    const { data: order, error } = await supabase
      .from('orders')
      .insert({
        diamond_id: diamondId,
        user_id: userId,
        side,
        order_type,
        price,
        quantity,
        filled_quantity: 0,
        status: 'open',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      order_id: order.id,
      diamond_id: diamondId,
      side,
      price,
      quantity,
      filled_quantity: 0,
      status: 'open',
      expires_at: windowEnd
    });

  } catch (err) {
    console.error('Order creation error:', err);
    return res.status(500).json({ error: 'Order failed' });
  }
}

export async function cancelOrder(req, res) {
  const { orderId } = req.params;
  const userId = req.user.id;

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .in('status', ['open', 'partial'])
      .single();

    if (!order) {
      return res.status(404).json({ error: 'Order not found or not cancellable' });
    }

    // Release reserved balance if buy order
    if (order.side === 'buy') {
      const unfilledValue = (order.quantity - order.filled_quantity) * order.price;
      
      const { data: balance } = await supabase
        .from('user_balances')
        .select('balance, reserved')
        .eq('user_id', userId)
        .single();

      await supabase
        .from('user_balances')
        .update({
          balance: (balance.balance || 0) + unfilledValue,
          reserved: Math.max(0, (balance.reserved || 0) - unfilledValue),
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);
    }

    await supabase
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', orderId);

    return res.json({ message: 'Order cancelled', order_id: orderId });

  } catch (err) {
    return res.status(500).json({ error: 'Cancel failed' });
  }
}

// ===== MARKET DATA =====

export async function getOrderBook(req, res) {
  const { diamondId } = req.params;
  const { depth = 20 } = req.query;

  try {
    // Bids
    const { data: bids } = await supabase
      .from('orders')
      .select('price, quantity, filled_quantity')
      .eq('diamond_id', diamondId)
      .eq('side', 'buy')
      .in('status', ['open', 'partial'])
      .order('price', { ascending: false })
      .limit(depth);

    // Asks
    const { data: asks } = await supabase
      .from('orders')
      .select('price, quantity, filled_quantity')
      .eq('diamond_id', diamondId)
      .eq('side', 'sell')
      .in('status', ['open', 'partial'])
      .order('price', { ascending: true })
      .limit(depth);

    // Aggregate by price
    const bidAggregates = {};
    bids?.forEach(b => {
      const available = b.quantity - (b.filled_quantity || 0);
      bidAggregates[b.price] = (bidAggregates[b.price] || 0) + available;
    });

    const askAggregates = {};
    asks?.forEach(a => {
      const available = a.quantity - (a.filled_quantity || 0);
      askAggregates[a.price] = (askAggregates[a.price] || 0) + available;
    });

    const bidList = Object.entries(bidAggregates)
      .map(([price, size]) => ({ price: parseFloat(price), size }))
      .sort((a, b) => b.price - a.price)
      .slice(0, depth);

    const askList = Object.entries(askAggregates)
      .map(([price, size]) => ({ price: parseFloat(price), size }))
      .sort((a, b) => a.price - b.price)
      .slice(0, depth);

    const bestBid = bidList[0]?.price || 0;
    const bestAsk = askList[0]?.price || 0;

    // Recent trades
    const { data: trades } = await supabase
      .from('fills')
      .select('price, quantity, created_at')
      .eq('diamond_id', diamondId)
      .order('created_at', { ascending: false })
      .limit(50);

    return res.json({
      diamond_id: diamondId,
      bids: bidList,
      asks: askList,
      spread: bestAsk - bestBid,
      mid: (bestBid + bestAsk) / 2,
      recent_trades: trades,
      timestamp: new Date()
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to load order book' });
  }
}

export async function getMyOrders(req, res) {
  try {
    const { data: orders } = await supabase
      .from('orders')
      .select(`
        *,
        diamonds!inner(estimated_carat, shape),
        jewelers!inner(business_name as jeweler_name)
      `)
      .eq('user_id', req.user.id)
      .in('status', ['open', 'partial'])
      .order('created_at', { ascending: false });

    return res.json({ orders });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load orders' });
  }
}

export async function getMyTrades(req, res) {
  try {
    const { data: fills } = await supabase
      .from('fills')
      .select(`
        *,
        diamonds!inner(estimated_carat, shape),
        jewelers!inner(business_name as jeweler_name),
        buy_orders!inner(user_id as buyer_id),
        sell_orders!inner(user_id as seller_id)
      `)
      .or(`buy_orders.user_id.eq.${req.user.id},sell_orders.user_id.eq.${req.user.id}`)
      .order('created_at', { ascending: false })
      .limit(100);

    const trades = fills?.map(f => ({
      ...f,
      my_side: f.buyer_id === req.user.id ? 'buy' : 'sell'
    }));

    return res.json({ trades });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load trades' });
  }
}

export async function getMarketStats(req, res) {
  try {
    const { data: stats } = await supabase
      .from('fills')
      .select(`
        count,
        quantity,
        price,
        buyer_fee,
        seller_fee
      `)
      .gt('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    const totalFills = stats?.length || 0;
    const totalVolume = stats?.reduce((sum, f) => sum + (f.quantity || 0), 0) || 0;
    const totalValue = stats?.reduce((sum, f) => sum + ((f.price || 0) * (f.quantity || 0)), 0) || 0;
    const totalFees = stats?.reduce((sum, f) => sum + ((f.buyer_fee || 0) + (f.seller_fee || 0)), 0) || 0;

    return res.json({
      total_fills_24h: totalFills,
      total_pcus_traded: totalVolume,
      total_volume: totalValue,
      total_fees: totalFees,
      avg_trade_price: totalFills > 0 ? totalValue / totalVolume : 0
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to load stats' });
  }
}
