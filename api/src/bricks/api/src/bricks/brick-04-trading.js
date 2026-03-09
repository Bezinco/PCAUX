// brick-04-trading.js
// PCAux Diamond Platform - Brick #4: Pre-Grade Trading Market
// Order book, price discovery, 30-day window, fee collection

import express from 'express';
import { Pool } from 'pg';
import { body, validationResult } from 'express-validator';
import { requireAuth } from './brick-01-auth.js';

const router = express.Router();
const pool = new Pool();

// Trading configuration
const PREGRADE_DAYS_DEFAULT = 30;
const MIN_PRICE_TICK = 0.01;
const MAKER_FEE_BPS = 25; // 0.25%
const TAKER_FEE_BPS = 50; // 0.50%
const PLATFORM_FEE_BPS = 75; // 0.75% total (split maker/taker)

// ===== ORDER BOOK =====

// Place limit order (maker)
router.post('/diamonds/:diamondId/orders', requireAuth, [
  body('side').isIn(['buy', 'sell']),
  body('price').isFloat({ min: 0.01 }),
  body('quantity').isInt({ min: 1 }),
  body('order_type').optional().isIn(['limit', 'ioc', 'fok']).default('limit')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { diamondId } = req.params;
  const { side, price, quantity, order_type = 'limit' } = req.body;
  const userId = req.user.id;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify diamond is in pre-grade trading window
    const { rows: [diamond] } = await client.query(`
      SELECT d.*, i.ipo_price, i.total_pcus, i.sold_pcus, i.closes_at as ipo_closed_at
      FROM diamonds d
      JOIN ipos i ON d.id = i.diamond_id
      WHERE d.id = $1 AND d.status = 'listing'
    `, [diamondId]);

    if (!diamond) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Diamond not in trading window' });
    }

    // Check if still in pre-grade window
    const ipoClosed = new Date(diamond.ipo_closed_at);
    const windowEnd = new Date(ipoClosed);
    windowEnd.setDate(windowEnd.getDate() + PREGRADE_DAYS_DEFAULT);
    
    if (new Date() > windowEnd) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'Pre-grade trading window closed',
        window_closed_at: windowEnd
      });
    }

    // For sell orders: verify PCU holdings
    if (side === 'sell') {
      const { rows: [holding] } = await client.query(`
        SELECT quantity FROM pcu_balances WHERE user_id = $1 AND diamond_id = $2
      `, [userId, diamondId]);

      const available = holding?.quantity || 0;
      
      // Check existing sell orders
      const { rows: [pending] } = await client.query(`
        SELECT COALESCE(SUM(quantity - filled_quantity), 0) as pending
        FROM orders WHERE user_id = $1 AND diamond_id = $2 AND side = 'sell' AND status IN ('open', 'partial')
      `, [userId, diamondId]);

      const availableAfterPending = available - (pending?.pending || 0);
      
      if (quantity > availableAfterPending) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Insufficient PCUs',
          available: availableAfterPending,
          requested: quantity,
          total_held: available,
          pending_orders: pending?.pending || 0
        });
      }
    }

    // For buy orders: verify USD balance
    if (side === 'buy') {
      const totalCost = price * quantity;
      const { rows: [balance] } = await client.query(`
        SELECT balance FROM user_balances WHERE user_id = $1
      `, [userId]);

      if (!balance || balance.balance < totalCost) {
        await client.query('ROLLBACK');
        return res.status(402).json({
          error: 'Insufficient balance',
          required: totalCost,
          available: balance?.balance || 0
        });
      }

      // Reserve balance
      await client.query(`
        UPDATE user_balances 
        SET balance = balance - $2, reserved = COALESCE(reserved, 0) + $2
        WHERE user_id = $1
      `, [userId, totalCost]);
    }

    // Create order
    const { rows: [order] } = await client.query(`
      INSERT INTO orders (
        diamond_id, user_id, side, order_type, price, quantity,
        filled_quantity, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 0, 'open', NOW())
      RETURNING *
    `, [diamondId, userId, side, order_type, price, quantity]);

    // Try to match immediately if IOC or if crossing spread
    if (order_type === 'ioc' || order_type === 'fok') {
      const fillResult = await matchOrder(client, order.id, diamondId, side, price, quantity, order_type);
      
      if (order_type === 'fok' && fillResult.filled < quantity) {
        // Cancel and refund
        await client.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
        if (side === 'buy') {
          await client.query(`
            UPDATE user_balances 
            SET balance = balance + $2, reserved = reserved - $2
            WHERE user_id = $1
          `, [userId, price * quantity]);
        }
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'FOK order could not be filled', filled: fillResult.filled });
      }
    }

    await client.query('COMMIT');

    res.status(201).json({
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
    await client.query('ROLLBACK');
    console.error('Order creation error:', err);
    res.status(500).json({ error: 'Order failed' });
  } finally {
    client.release();
  }
});

// Match orders (internal function)
async function matchOrder(client, orderId, diamondId, side, price, quantity, orderType) {
  const oppositeSide = side === 'buy' ? 'sell' : 'buy';
  const comparator = side === 'buy' ? '<=' : '>='; // Buy matches sells at <= price, sell matches buys at >= price

  // Find matching orders
  const { rows: matches } = await client.query(`
    SELECT * FROM orders 
    WHERE diamond_id = $1 AND side = $2 AND status IN ('open', 'partial')
      AND price ${comparator} $3
    ORDER BY price ${side === 'buy' ? 'ASC' : 'DESC'}, created_at ASC
    FOR UPDATE SKIP LOCKED
  `, [diamondId, oppositeSide, price]);

  let remaining = quantity;
  const fills = [];

  for (const match of matches) {
    if (remaining <= 0) break;

    const matchAvailable = match.quantity - match.filled_quantity;
    const fillQty = Math.min(remaining, matchAvailable);
    const fillPrice = match.price; // Price improvement: match price, not order price

    // Create fill record
    const { rows: [fill] } = await client.query(`
      INSERT INTO fills (buy_order_id, sell_order_id, diamond_id, price, quantity, buyer_fee, seller_fee, created_at)
      VALUES (
        CASE WHEN $1 = 'buy' THEN $2 ELSE $3 END,
        CASE WHEN $1 = 'sell' THEN $2 ELSE $3 END,
        $4, $5, $6,
        $5 * $6 * ${TAKER_FEE_BPS / 10000},
        $5 * $6 * ${MAKER_FEE_BPS / 10000},
        NOW()
      ) RETURNING *
    `, [side, orderId, match.id, diamondId, fillPrice, fillQty]);

    fills.push(fill);

    // Update PCU balances
    const buyerId = side === 'buy' ? orderId : match.user_id; // Simplified - need actual user lookup
    const sellerId = side === 'sell' ? orderId : match.user_id;

    // Actually need to fetch user IDs properly
    const { rows: [orderUser] } = await client.query(`SELECT user_id FROM orders WHERE id = $1`, [orderId]);
    const { rows: [matchUser] } = await client.query(`SELECT user_id FROM orders WHERE id = $1`, [match.id]);

    const buyerUserId = side === 'buy' ? orderUser.user_id : matchUser.user_id;
    const sellerUserId = side === 'sell' ? orderUser.user_id : matchUser.user_id;

    // Transfer PCUs
    await client.query(`
      INSERT INTO pcu_balances (user_id, diamond_id, ipo_id, quantity, acquired_at)
      VALUES ($1, $2, (SELECT ipo_id FROM orders WHERE id = $3), $4, NOW())
      ON CONFLICT (user_id, diamond_id) 
      DO UPDATE SET quantity = pcu_balances.quantity + $4, updated_at = NOW()
    `, [buyerUserId, diamondId, match.id, fillQty]);

    await client.query(`
      UPDATE pcu_balances SET quantity = quantity - $3, updated_at = NOW()
      WHERE user_id = $1 AND diamond_id = $2
    `, [sellerUserId, diamondId, fillQty]);

    // Update matched order
    const newFilled = match.filled_quantity + fillQty;
    const newStatus = newFilled >= match.quantity ? 'filled' : 'partial';
    await client.query(`
      UPDATE orders SET filled_quantity = $2, status = $3 WHERE id = $1
    `, [match.id, newFilled, newStatus]);

    remaining -= fillQty;
  }

  // Update original order
  const filledQty = quantity - remaining;
  const finalStatus = remaining <= 0 ? 'filled' : (orderType === 'ioc' ? 'cancelled' : 'partial');
  
  await client.query(`
    UPDATE orders SET filled_quantity = $2, status = $3 WHERE id = $1
  `, [orderId, filledQty, finalStatus]);

  // Release reserved balance for unfilled portion if buy order
  if (side === 'buy' && remaining > 0) {
    const { rows: [orderUser] } = await client.query(`SELECT user_id FROM orders WHERE id = $1`, [orderId]);
    await client.query(`
      UPDATE user_balances 
      SET balance = balance + $2, reserved = reserved - $2
      WHERE user_id = $1
    `, [orderUser.user_id, price * remaining]);
  }

  return { filled: filledQty, remaining, fills };
}

// Cancel order
router.post('/orders/:orderId/cancel', requireAuth, async (req, res) => {
  const { orderId } = req.params;
  const userId = req.user.id;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [order] } = await client.query(`
      SELECT * FROM orders WHERE id = $1 AND user_id = $2 AND status IN ('open', 'partial')
    `, [orderId, userId]);

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found or not cancellable' });
    }

    // Release reserved balance if buy order
    if (order.side === 'buy') {
      const unfilledValue = (order.quantity - order.filled_quantity) * order.price;
      await client.query(`
        UPDATE user_balances 
        SET balance = balance + $2, reserved = reserved - $2
        WHERE user_id = $1
      `, [userId, unfilledValue]);
    }

    await client.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [orderId]);

    await client.query('COMMIT');

    res.json({ message: 'Order cancelled', order_id: orderId });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Cancel failed' });
  } finally {
    client.release();
  }
});

// ===== MARKET DATA =====

// Get order book for diamond
router.get('/diamonds/:diamondId/orderbook', async (req, res) => {
  const { diamondId } = req.params;
  const { depth = 20 } = req.query;

  try {
    // Bids (buy orders)
    const { rows: bids } = await pool.query(`
      SELECT price, SUM(quantity - filled_quantity) as size
      FROM orders
      WHERE diamond_id = $1 AND side = 'buy' AND status IN ('open', 'partial')
      GROUP BY price
      ORDER BY price DESC
      LIMIT $2
    `, [diamondId, depth]);

    // Asks (sell orders)
    const { rows: asks } = await pool.query(`
      SELECT price, SUM(quantity - filled_quantity) as size
      FROM orders
      WHERE diamond_id = $1 AND side = 'sell' AND status IN ('open', 'partial')
      GROUP BY price
      ORDER BY price ASC
      LIMIT $2
    `, [diamondId, depth]);

    // Spread and mid
    const bestBid = bids[0]?.price || 0;
    const bestAsk = asks[0]?.price || 0;
    const spread = bestAsk - bestBid;
    const mid = (bestBid + bestAsk) / 2;

    // Recent trades
    const { rows: trades } = await pool.query(`
      SELECT price, quantity, created_at as time
      FROM fills
      WHERE diamond_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [diamondId]);

    res.json({
      diamond_id: diamondId,
      bids,
      asks,
      spread,
      mid,
      recent_trades: trades,
      timestamp: new Date()
    });

  } catch (err) {
    res.status(500).json({ error: 'Failed to load order book' });
  }
});

// Get price history (candles)
router.get('/diamonds/:diamondId/candles', async (req, res) => {
  const { diamondId } = req.params;
  const { interval = '1h', limit = 100 } = req.query;

  try {
    const { rows } = await pool.query(`
      SELECT 
        date_trunc($1, created_at) as time,
        MIN(price) as low,
        MAX(price) as high,
        (SELECT price FROM fills WHERE diamond_id = $2 AND date_trunc($1, created_at) = date_trunc($1, f.created_at) ORDER BY created_at ASC LIMIT 1) as open,
        (SELECT price FROM fills WHERE diamond_id = $2 AND date_trunc($1, created_at) = date_trunc($1, f.created_at) ORDER BY created_at DESC LIMIT 1) as close,
        SUM(quantity) as volume
      FROM fills f
      WHERE diamond_id = $2
      GROUP BY date_trunc($1, created_at)
      ORDER BY time DESC
      LIMIT $3
    `, [interval, diamondId, limit]);

    res.json({ candles: rows.reverse() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load candles' });
  }
});

// ===== MY ORDERS & TRADES =====

// Get my open orders
router.get('/my/orders', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.*, d.estimated_carat, d.shape, j.business_name as jeweler_name
      FROM orders o
      JOIN diamonds d ON o.diamond_id = d.id
      JOIN jewelers j ON d.jeweler_id = j.id
      WHERE o.user_id = $1 AND o.status IN ('open', 'partial')
      ORDER BY o.created_at DESC
    `, [req.user.id]);

    res.json({ orders: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// Get my trade history
router.get('/my/trades', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        f.*,
        CASE WHEN o_buy.user_id = $1 THEN 'buy' ELSE 'sell' END as my_side,
        d.estimated_carat, d.shape,
        j.business_name as jeweler_name
      FROM fills f
      JOIN orders o_buy ON f.buy_order_id = o_buy.id
      JOIN orders o_sell ON f.sell_order_id = o_sell.id
      JOIN diamonds d ON f.diamond_id = d.id
      JOIN jewelers j ON d.jeweler_id = j.id
      WHERE o_buy.user_id = $1 OR o_sell.user_id = $1
      ORDER BY f.created_at DESC
      LIMIT 100
    `, [req.user.id]);

    res.json({ trades: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load trades' });
  }
});

// ===== MARKET METRICS =====

// Get trading volume stats
router.get('/market/stats', async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT 
        COUNT(DISTINCT diamond_id) as active_diamonds,
        COUNT(*) as total_orders_24h,
        SUM(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN quantity ELSE 0 END) as volume_24h,
        SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN quantity ELSE 0 END) as volume_7d,
        AVG(price) as avg_trade_price
      FROM fills
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

export default router;
