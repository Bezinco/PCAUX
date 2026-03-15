// brick-03-ipo.js
// PCAux Diamond Platform - Brick #3: IPO Engine with Cap Mechanics
// PCU minting, wallet limits, 48-hour subscription, treasury management
// Enhanced with: auto-close queue, payment processing, price discovery, analytics

import express from 'express';
import { Pool } from 'pg';
import { body, validationResult } from 'express-validator';
import PgBoss from 'pg-boss';
import Stripe from 'stripe';
import { requireAuth, requireJeweler } from './brick-01-auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const pool = new Pool();

// Initialize job queue
const boss = new PgBoss(process.env.DATABASE_URL);
boss.start();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

// IPO Configuration
const IPO_DURATION_HOURS = 48;
const MIN_IPO_PRICE = 25;
const MAX_IPO_PRICE = 100;
const DEFAULT_TOTAL_PCUS = 200; // Updated from 100
const PER_WALLET_CAP_PERCENT = 10;
const QUALITY_KING_BONUS = {
  novice: 0,
  apprentice: 2,
  journeyman: 5,
  expert: 10,
  grandmaster: 15
};

// ===== PRICE DISCOVERY =====

// Dynamic pricing based on comparable sales
async function calculateOptimalPrice(diamondId, estimated_carat, estimated_color, estimated_clarity) {
  const { rows: [similar] } = await pool.query(`
    SELECT AVG(i.ipo_price) as avg_price,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY i.ipo_price) as median_price,
           COUNT(*) as sample_size
    FROM ipos i
    JOIN diamonds d ON i.diamond_id = d.id
    WHERE d.estimated_carat BETWEEN $1 * 0.9 AND $1 * 1.1
    AND d.estimated_color = $2
    AND d.estimated_clarity = $3
    AND i.status = 'closed'
    AND i.created_at > NOW() - INTERVAL '90 days'
  `, [estimated_carat, estimated_color, estimated_clarity]);

  if (!similar || similar.sample_size < 3) {
    // Insufficient data, use carat-based floor
    return Math.max(MIN_IPO_PRICE, estimated_carat * 50);
  }

  // Return median (more robust than mean)
  return Math.min(MAX_IPO_PRICE, Math.max(MIN_IPO_PRICE, similar.median_price));
}

// ===== IPO CREATION =====

router.post('/diamonds/:diamondId/ipo', requireJeweler, [
  body('ipo_price').optional().isFloat({ min: MIN_IPO_PRICE, max: MAX_IPO_PRICE }),
  body('total_pcus').optional().isInt({ min: 50, max: 500 }),
  body('duration_hours').optional().isInt({ min: 24, max: 168 }),
  body('use_dynamic_pricing').optional().isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { diamondId } = req.params;
  const { 
    ipo_price, 
    total_pcus = DEFAULT_TOTAL_PCUS, 
    duration_hours = IPO_DURATION_HOURS,
    use_dynamic_pricing = true 
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify diamond
    const { rows: [diamond] } = await client.query(`
      SELECT estimated_carat, estimated_color, estimated_clarity, estimated_cut, shape
      FROM diamonds WHERE id = $1 AND jeweler_id = $2 AND status = 'verified'
    `, [diamondId, req.jeweler.id]);

    if (!diamond) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Diamond not found or not verified' });
    }

    // Check existing IPO
    const { rows: [existing] } = await client.query(`
      SELECT id FROM ipos WHERE diamond_id = $1 AND status IN ('open', 'pending')
    `, [diamondId]);

    if (existing) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Active IPO already exists' });
    }

    // Determine price
    let finalPrice = ipo_price;
    if (use_dynamic_pricing || !ipo_price) {
      finalPrice = await calculateOptimalPrice(
        diamondId, 
        diamond.estimated_carat, 
        diamond.estimated_color, 
        diamond.estimated_clarity
      );
    }

    const total_value = finalPrice * total_pcus;
    const closes_at = new Date(Date.now() + duration_hours * 60 * 60 * 1000);

    // Create IPO
    const { rows: [ipo] } = await client.query(`
      INSERT INTO ipos (
        diamond_id, jeweler_id, ipo_price, total_pcus, sold_pcus,
        total_value, status, opens_at, closes_at, duration_hours, 
        pricing_method, created_at
      ) VALUES ($1, $2, $3, $4, 0, $5, 'open', NOW(), $6, $7, $8, NOW())
      RETURNING *
    `, [
      diamondId, req.jeweler.id, finalPrice, total_pcus, total_value, 
      closes_at, duration_hours, use_dynamic_pricing ? 'dynamic' : 'manual'
    ]);

    // Schedule auto-close job
    await boss.send('ipo-auto-close', 
      { ipoId: ipo.id, diamondId }, 
      { startAfter: closes_at }
    );

    // Update diamond status
    await client.query(`
      UPDATE diamonds SET status = 'listing', updated_at = NOW() WHERE id = $1
    `, [diamondId]);

    // Log metrics
    await client.query(`
      INSERT INTO ipo_creation_metrics (ipo_id, suggested_price, final_price, confidence_score, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [ipo.id, ipo_price || null, finalPrice, use_dynamic_pricing ? 0.8 : 1.0]);

    await client.query('COMMIT');

    res.status(201).json({
      ipo_id: ipo.id,
      diamond_id: diamondId,
      ipo_price: finalPrice,
      total_pcus,
      total_value,
      closes_at,
      pricing_method: use_dynamic_pricing ? 'dynamic' : 'manual',
      per_wallet_cap: Math.floor(total_pcus * (PER_WALLET_CAP_PERCENT / 100)),
      message: 'IPO live. Auto-close scheduled.'
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('IPO creation error:', err);
    res.status(500).json({ error: 'IPO creation failed' });
  } finally {
    client.release();
  }
});

// Auto-close worker
boss.work('ipo-auto-close', async (job) => {
  const { ipoId, diamondId } = job.data;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Close IPO if still open
    const { rows: [ipo] } = await client.query(`
      UPDATE ipos 
      SET status = CASE 
        WHEN sold_pcus >= (total_pcus * 0.5) THEN 'closed'
        ELSE 'failed'
      END,
      updated_at = NOW()
      WHERE id = $1 AND status = 'open' AND closes_at <= NOW()
      RETURNING status, sold_pcus, total_pcus, total_value
    `, [ipoId]);

    if (!ipo) {
      await client.query('COMMIT');
      return { success: false, reason: 'Already closed or not found' };
    }

    // If failed, trigger refunds
    if (ipo.status === 'failed') {
      await client.query(`
        INSERT INTO ipo_refund_queue (ipo_id, status, created_at)
        VALUES ($1, 'pending', NOW())
      `, [ipoId]);
    }

    // If closed, process jeweler payment
    if (ipo.status === 'closed') {
      const jewelerPayment = ipo.total_value * 0.95; // 5% platform fee
      
      await client.query(`
        INSERT INTO jeweler_payments (ipo_id, jeweler_id, gross_amount, platform_fee, net_amount, status, created_at)
        VALUES ($1, (SELECT jeweler_id FROM ipos WHERE id = $1), $2, $3, $4, 'pending', NOW())
      `, [ipoId, ipo.total_value, ipo.total_value * 0.05, jewelerPayment]);

      // Update diamond to grading queue
      await client.query(`
        UPDATE diamonds SET status = 'pending_grading' WHERE id = $1
      `, [diamondId]);
    }

    await client.query('COMMIT');

    return { 
      success: true, 
      status: ipo.status, 
      sold_pcus: ipo.sold_pcus,
      total_pcus: ipo.total_pcus 
    };

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Auto-close error:', err);
    throw err;
  } finally {
    client.release();
  }
});

// ===== PAYMENT PROCESSING =====

// Create payment intent for IPO subscription
router.post('/ipos/:ipoId/payment-intent', requireAuth, async (req, res) => {
  const { ipoId } = req.params;
  const { quantity } = req.body;

  try {
    const { rows: [ipo] } = await pool.query(`
      SELECT i.*, d.business_name as jeweler_name
      FROM ipos i
      JOIN diamonds dia ON i.diamond_id = dia.id
      JOIN jewelers d ON i.jeweler_id = d.id
      WHERE i.id = $1 AND i.status = 'open'
    `, [ipoId]);

    if (!ipo) return res.status(404).json({ error: 'IPO not found or closed' });

    const amount = quantity * ipo.ipo_price * 100; // Stripe uses cents

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        ipoId,
        userId: req.user.id,
        quantity: quantity.toString(),
        diamondId: ipo.diamond_id
      },
      description: `${quantity} PCUs in ${ipo.jeweler_name}'s ${ipo.diamond_id} IPO`
    });

    res.json({ clientSecret: paymentIntent.client_secret });

  } catch (err) {
    res.status(500).json({ error: 'Payment intent creation failed' });
  }
});

// Stripe webhook for payment confirmation
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    const { ipoId, userId, quantity } = paymentIntent.metadata;

    // Confirm subscription (idempotent)
    await confirmSubscription(ipoId, userId, parseInt(quantity), paymentIntent.id);
  }

  res.json({ received: true });
});

async function confirmSubscription(ipoId, userId, quantity, paymentIntentId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check already processed
    const { rows: [existing] } = await client.query(`
      SELECT id FROM ipo_subscriptions WHERE payment_intent_id = $1
    `, [paymentIntentId]);

    if (existing) {
      await client.query('COMMIT');
      return { alreadyProcessed: true };
    }

    // Get IPO with lock
    const { rows: [ipo] } = await client.query(`
      SELECT * FROM ipos WHERE id = $1 FOR UPDATE
    `, [ipoId]);

    if (ipo.status !== 'open') {
      // Refund if IPO closed
      await stripe.refunds.create({ payment_intent: paymentIntentId });
      await client.query('COMMIT');
      return { refunded: true, reason: 'IPO closed' };
    }

    // Check cap
    const { rows: [held] } = await client.query(`
      SELECT COALESCE(SUM(quantity), 0) as total FROM ipo_subscriptions 
      WHERE ipo_id = $1 AND user_id = $2
    `, [ipoId, userId]);

    const maxCap = Math.floor(ipo.total_pcus * ((PER_WALLET_CAP_PERCENT + 15) / 100)); // Max bonus
    if (parseInt(held.total) + quantity > maxCap) {
      // Partial refund or reject
      await stripe.refunds.create({ payment_intent: paymentIntentId });
      await client.query('COMMIT');
      return { refunded: true, reason: 'Cap exceeded' };
    }

    // Record subscription
    const totalCost = quantity * ipo.ipo_price;
    await client.query(`
      INSERT INTO ipo_subscriptions (ipo_id, user_id, quantity, price_per_pcu, total_cost, status, payment_intent_id, created_at)
      VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, NOW())
    `, [ipoId, userId, quantity, ipo.ipo_price, totalCost, paymentIntentId]);

    // Update IPO
    const newSold = ipo.sold_pcus + quantity;
    const newStatus = newSold >= ipo.total_pcus ? 'closed' : 'open';

    await client.query(`
      UPDATE ipos SET sold_pcus = $2, status = $3, updated_at = NOW() WHERE id = $1
    `, [ipoId, newSold, newStatus]);

    // Mint PCUs
    await client.query(`
      INSERT INTO pcu_balances (user_id, diamond_id, ipo_id, quantity, acquired_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, diamond_id) 
      DO UPDATE SET quantity = pcu_balances.quantity + $4, updated_at = NOW()
    `, [userId, ipo.diamond_id, ipoId, quantity]);

    await client.query('COMMIT');

    return { success: true, pcus_minted: quantity };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ===== IPO SUBSCRIPTION (Legacy - for testing) =====

router.post('/ipos/:ipoId/buy', requireAuth, [
  body('quantity').isInt({ min: 1 })
], async (req, res) => {
  // Only allow in test mode or for balance-based purchases
  if (process.env.NODE_ENV !== 'test' && !req.user.test_mode) {
    return res.status(400).json({ error: 'Use payment intent flow for production' });
  }

  // ... rest of legacy implementation for testing
});

// ===== SECONDARY MARKET: PCU TRANSFERS =====

router.post('/pcus/transfer', requireAuth, [
  body('diamond_id').isUUID(),
  body('quantity').isInt({ min: 1 }),
  body('to_user_id').isUUID(),
  body('price_per_pcu').isFloat({ min: 0.01 })
], async (req, res) => {
  const { diamond_id, quantity, to_user_id, price_per_pcu } = req.body;
  const from_user_id = req.user.id;

  if (from_user_id === to_user_id) {
    return res.status(400).json({ error: 'Cannot transfer to self' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify sender has PCUs
    const { rows: [sender] } = await client.query(`
      SELECT quantity FROM pcu_balances WHERE user_id = $1 AND diamond_id = $2
    `, [from_user_id, diamond_id]);

    if (!sender || sender.quantity < quantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient PCUs' });
    }

    // Verify recipient exists
    const { rows: [recipient] } = await client.query(`
      SELECT id FROM users WHERE id = $1 AND status = 'active'
    `, [to_user_id]);

    if (!recipient) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recipient not found' });
    }

    // Execute transfer
    await client.query(`
      UPDATE pcu_balances SET quantity = quantity - $3, updated_at = NOW()
      WHERE user_id = $1 AND diamond_id = $2
    `, [from_user_id, diamond_id, quantity]);

    await client.query(`
      INSERT INTO pcu_balances (user_id, diamond_id, ipo_id, quantity, acquired_at)
      VALUES ($1, $2, (SELECT ipo_id FROM pcu_balances WHERE user_id = $4 AND diamond_id = $2 LIMIT 1), $3, NOW())
      ON CONFLICT (user_id, diamond_id) 
      DO UPDATE SET quantity = pcu_balances.quantity + $3, updated_at = NOW()
    `, [to_user_id, diamond_id, quantity, from_user_id]);

    // Record transfer for audit
    await client.query(`
      INSERT INTO pcu_transfers (diamond_id, from_user_id, to_user_id, quantity, price_per_pcu, total_value, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [diamond_id, from_user_id, to_user_id, quantity, price_per_pcu, quantity * price_per_pcu]);

    await client.query('COMMIT');

    res.json({ 
      success: true, 
      transferred: quantity, 
      diamond_id, 
      to_user_id,
      price_per_pcu
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Transfer failed' });
  } finally {
    client.release();
  }
});

// ===== REFUND MECHANISM =====

router.post('/ipos/:ipoId/refund', requireJeweler, async (req, res) => {
  const { ipoId } = req.params;
  const { reason } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [ipo] } = await client.query(`
      SELECT * FROM ipos WHERE id = $1 AND jeweler_id = $2
    `, [ipoId, req.jeweler.id]);

    if (!ipo) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'IPO not found' });
    }

    if (ipo.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only open IPOs can be cancelled for refund' });
    }

    // Get all subscribers
    const { rows: subscribers } = await client.query(`
      SELECT user_id, quantity, total_cost, payment_intent_id 
      FROM ipo_subscriptions 
      WHERE ipo_id = $1 AND status = 'confirmed'
    `, [ipoId]);

    // Process refunds
    for (const sub of subscribers) {
      if (sub.payment_intent_id) {
        // Stripe refund
        await stripe.refunds.create({ 
          payment_intent: sub.payment_intent_id,
          reason: 'requested_by_customer'
        });
      } else {
        // Balance refund (test mode)
        await client.query(`
          UPDATE user_balances SET balance = balance + $2, updated_at = NOW()
          WHERE user_id = $1
        `, [sub.user_id, sub.total_cost]);
      }

      // Burn PCUs
      await client.query(`
        DELETE FROM pcu_balances WHERE user_id = $1 AND diamond_id = (SELECT diamond_id FROM ipos WHERE id = $2)
      `, [sub.user_id, ipoId]);
    }

    // Mark IPO cancelled
    await client.query(`
      UPDATE ipos SET status = 'cancelled', updated_at = NOW() WHERE id = $1
    `, [ipoId]);

    // Update diamond back to verified
    await client.query(`
      UPDATE diamonds SET status = 'verified', updated_at = NOW() WHERE id = (SELECT diamond_id FROM ipos WHERE id = $1)
    `, [ipoId]);

    await client.query('COMMIT');

    res.json({ 
      refunded_subscribers: subscribers.length, 
      total_refunded: subscribers.reduce((sum, s) => sum + parseFloat(s.total_cost), 0),
      reason 
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Refund failed' });
  } finally {
    client.release();
  }
});

// ===== ANALYTICS =====

// Jeweler IPO performance
router.get('/analytics/ipos', requireJeweler, async (req, res) => {
  const { days = 30 } = req.query;

  const { rows } = await pool.query(`
    SELECT 
      COUNT(*) as total_ipos,
      COUNT(CASE WHEN status = 'closed' THEN 1 END) as successful_ipos,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_ipos,
      AVG(ipo_price) as avg_price,
      AVG(EXTRACT(EPOCH FROM (COALESCE(closes_at, NOW()) - opens_at)) / 3600) as avg_duration_hours,
      AVG(sold_pcus::FLOAT / NULLIF(total_pcus, 0)) as avg_fill_rate,
      SUM(sold_pcus) as total_pcus_sold,
      SUM(total_value) as total_volume,
      AVG((SELECT total_multiplier FROM graded_valuations gv JOIN diamonds d ON gv.diamond_id = d.id WHERE d.id = ipos.diamond_id)) as avg_grade_multiplier
    FROM ipos
    WHERE jeweler_id = $1
    AND created_at > NOW() - INTERVAL '${days} days'
  `, [req.jeweler.id]);

  // Time-to-fill distribution
  const { rows: fillDistribution } = await pool.query(`
    SELECT 
      CASE 
        WHEN EXTRACT(EPOCH FROM (closes_at - opens_at)) < 3600 THEN '< 1 hour'
        WHEN EXTRACT(EPOCH FROM (closes_at - opens_at)) < 86400 THEN '< 1 day'
        ELSE '> 1 day'
      END as bucket,
      COUNT(*) as count
    FROM ipos
    WHERE jeweler_id = $1 AND status = 'closed'
    AND created_at > NOW() - INTERVAL '${days} days'
    GROUP BY 1
  `, [req.jeweler.id]);

  res.json({
    summary: rows[0],
    fill_distribution: fillDistribution,
    period_days: days
  });
});

// Platform-wide IPO metrics (admin)
router.get('/admin/analytics/ipos', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT 
      DATE_TRUNC('day', created_at) as date,
      COUNT(*) as ipos_created,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as ipos_closed,
      SUM(total_value) as volume,
      AVG(sold_pcus::FLOAT / NULLIF(total_pcus, 0)) as avg_fill_rate
    FROM ipos
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY 1
    ORDER BY 1
  `);

  res.json({ daily_metrics: rows });
});

// ===== QUERIES =====

router.get('/ipos/:ipoId', async (req, res) => {
  const { ipoId } = req.params;

  const { rows: [ipo] } = await pool.query(`
    SELECT 
      i.*,
      d.estimated_carat, d.estimated_color, d.estimated_clarity, d.estimated_cut,
      d.shape, d.images, d.jeweler_id,
      j.business_name as jeweler_name,
      j.quality_king_tier as jeweler_tier,
      EXTRACT(EPOCH FROM (i.closes_at - NOW())) as seconds_remaining,
      (SELECT COUNT(*) FROM ipo_subscriptions WHERE ipo_id = i.id) as unique_investors
    FROM ipos i
    JOIN diamonds d ON i.diamond_id = d.id
    JOIN jewelers j ON i.jeweler_id = j.id
    WHERE i.id = $1
  `, [ipoId]);

  if (!ipo) return res.status(404).json({ error: 'IPO not found' });

  if (ipo.images) ipo.images = JSON.parse(ipo.images);
  
  if (ipo.status === 'open' && new Date() > new Date(ipo.closes_at)) {
    ipo.status = 'closed';
    ipo.seconds_remaining = 0;
  }

  res.json(ipo);
});

router.get('/ipos', async (req, res) => {
  const { status = 'open', jeweler_id, limit = 20, offset = 0 } = req.query;

  let where = 'WHERE i.status = $1';
  const params = [status];

  if (jeweler_id) {
    where += ` AND i.jeweler_id = $${params.length + 1}`;
    params.push(jeweler_id);
  }

  const { rows } = await pool.query(`
    SELECT 
      i.id, i.ipo_price, i.total_pcus, i.sold_pcus, i.status,
      i.opens_at, i.closes_at, i.pricing_method,
      d.id as diamond_id, d.estimated_carat, d.estimated_color,
      d.estimated_clarity, d.shape, d.images,
      j.business_name as jeweler_name,
      j.quality_king_tier as jeweler_tier,
      EXTRACT(EPOCH FROM (i.closes_at - NOW())) as seconds_remaining,
      (SELECT AVG(total_multiplier) FROM graded_valuations gv JOIN diamonds dia ON gv.diamond_id = dia.id WHERE dia.jeweler_id = j.id) as jeweler_avg_multiplier
    FROM ipos i
    JOIN diamonds d ON i.diamond_id = d.id
    JOIN jewelers j ON i.jeweler_id = j.id
    ${where}
    ORDER BY i.created_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, limit, offset]);

  rows.forEach(r => {
    if (r.images) r.images = JSON.parse(r.images);
    if (r.status === 'open' && r.seconds_remaining < 0) {
      r.status = 'closed';
      r.seconds_remaining = 0;
    }
  });

  res.json({ ipos: rows, limit, offset });
});

export default router;
