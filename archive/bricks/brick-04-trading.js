// archive/bricks/brick-04-trading.js
// PCAux Diamond Platform - Brick #4: Trading Market (Atomic Version)
// NOTE: Requires Supabase SQL functions from migration above

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ===== ORDER MANAGEMENT (Atomic via RPC) =====

export async function placeOrder(req, res) {
  const { diamondId } = req.params;
  const { side, price, quantity, order_type = 'limit' } = req.body;
  const userId = req.user.id;

  const { data, error } = await supabase.rpc('place_order_atomic', {
    p_user_id: userId,
    p_diamond_id: diamondId,
    p_side: side,
    p_price: price,
    p_quantity: quantity,
    p_order_type: order_type
  });

  if (error) {
    return res.status(500).json({ error: 'Database error', details: error.message });
  }

  if (!data.success) {
    // Map error codes to HTTP status
    const statusMap = {
      'INSUFFICIENT_FUNDS': 402,
      'INSUFFICIENT_PCUS': 400,
      'NOT_LISTING': 404,
      'WINDOW_CLOSED': 400,
      'INVALID_SIDE': 400
    };
    
    return res.status(statusMap[data.code] || 400).json({
      error: data.error,
      code: data.code,
      details: data
    });
  }

  return res.status(201).json({
    order_id: data.order_id,
    diamond_id: data.diamond_id,
    side: data.side,
    price: data.price,
    quantity: data.quantity,
    filled_quantity: data.filled_quantity,
    status: data.status,
    expires_at: data.expires_at
  });
}

export async function cancelOrder(req, res) {
  const { orderId } = req.params;
  const userId = req.user.id;

  const { data, error } = await supabase.rpc('cancel_order_atomic', {
    p_order_id: orderId,
    p_user_id: userId
  });

  if (error) {
    return res.status(500).json({ error: 'Database error' });
  }

  if (!data.success) {
    return res.status(404).json({ error: data.error, code: data.code });
  }

  return res.json({
    message: data.message,
    order_id: data.order_id,
    released_value: data.released_value
  });
}

// ===== MARKET DATA (Read-only, no atomic needed) =====

export async function getOrderBook(req, res) {
  const { diamondId } = req.params;
  const { depth = 20 } = req.query;

  try {
    // Use RPC for atomic aggregation or raw query for speed
    const { data: bids } = await supabase
      .from('order_book_view')  // Materialized view for performance
      .select('price, total_size')
      .eq('diamond_id', diamondId)
      .eq('side', 'buy')
      .order('price', { ascending: false })
      .limit(depth);

    const { data: asks } = await supabase
      .from('order_book_view')
      .select('price, total_size')
      .eq('diamond_id', diamondId)
      .eq('side', 'sell')
      .order('price', { ascending: true })
      .limit(depth);

    const bestBid = bids?.[0]?.price || 0;
    const bestAsk = asks?.[0]?.price || 0;

    return res.json({
      diamond_id: diamondId,
      bids: bids || [],
      asks: asks || [],
      spread: bestAsk - bestBid,
      mid: (bestBid + bestAsk) / 2,
      timestamp: new Date().toISOString()
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
        diamonds(estimated_carat, shape)
      `)
      .eq('user_id', req.user.id)
      .in('status', ['open', 'partial'])
      .order('created_at', { ascending: false });

    return res.json({ orders: orders || [] });
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
        diamonds(estimated_carat, shape)
      `)
      .or(`buyer_id.eq.${req.user.id},seller_id.eq.${req.user.id}`)
      .order('created_at', { ascending: false })
      .limit(100);

    const trades = fills?.map(f => ({
      ...f,
      my_side: f.buyer_id === req.user.id ? 'buy' : 'sell'
    }));

    return res.json({ trades: trades || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load trades' });
  }
}

// ===== ADMIN / MATCHING =====

export async function triggerMatching(req, res) {
  // Admin-only endpoint to trigger order matching
  const { diamondId } = req.params;
  
  const { data, error } = await supabase.rpc('match_orders_atomic', {
    p_diamond_id: diamondId
  });

  if (error) {
    return res.status(500).json({ error: 'Matching failed', details: error.message });
  }

  return res.json(data);
}

// ===== Vercel Handler Export =====

export default async function handler(req, res) {
  const { path } = req.query;
  
  try {
    switch (path[0]) {
      case 'diamonds':
        if (path[2] === 'orders' && req.method === 'POST') {
          req.params = { diamondId: path[1] };
          return await placeOrder(req, res);
        }
        if (path[2] === 'orderbook' && req.method === 'GET') {
          req.params = { diamondId: path[1] };
          return await getOrderBook(req, res);
        }
        if (path[2] === 'match' && req.method === 'POST') {
          req.params = { diamondId: path[1] };
          return await triggerMatching(req, res);
        }
        break;
        
      case 'orders':
        if (path[2] === 'cancel' && req.method === 'POST') {
          req.params = { orderId: path[1] };
          return await cancelOrder(req, res);
        }
        break;
        
      case 'my':
        if (path[1] === 'orders' && req.method === 'GET') return await getMyOrders(req, res);
        if (path[1] === 'trades' && req.method === 'GET') return await getMyTrades(req, res);
        break;
        
      default:
        return res.status(404).json({ error: 'Endpoint not found' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Internal error', details: err.message });
  }
}
