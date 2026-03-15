// brick-06-settlement.js
// PCAux Diamond Platform - Brick #6: Settlement & Redemption
// Jeweler delivery, cash alternative, PCU burn, profit distribution
// Enhanced with: multi-sig redemption, redemption marketplace, auction integration, analytics

import express from 'express';
import { Pool } from 'pg';
import { body, validationResult } from 'express-validator';
import { requireAuth, requireJeweler } from './brick-01-auth.js';

const router = express.Router();
const pool = new Pool();

// Settlement configuration
const REDEMPTION_WINDOW_DAYS = 7;
const CASH_PENALTY_BPS = 500; // 5%
const JEWELER_DELIVERY_FEE = 50;
const INSURANCE_FEE_BPS = 25;
const MINIMUM_REDEEM_PCUS = 101; // 50.5% of 200

// ===== SINGLE REDEMPTION =====

router.post('/diamonds/:diamondId/redeem', requireAuth, [
  body('delivery_address').isLength({ min: 10 }),
  body('delivery_method').isIn(['jeweler_pickup', 'insured_shipment']),
  body('insurance_required').optional().isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { diamondId } = req.params;
  const { delivery_address, delivery_method, insurance_required = true } = req.body;
  const userId = req.user.id;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [diamond] } = await client.query(`
      SELECT d.*, gv.graded_value, j.business_name, j.id as jeweler_id, i.total_pcus
      FROM diamonds d
      JOIN graded_valuations gv ON d.id = gv.diamond_id
      JOIN jewelers j ON d.jeweler_id = j.id
      JOIN ipos i ON d.id = i.diamond_id
      WHERE d.id = $1 AND d.status = 'resolved'
    `, [diamondId]);

    if (!diamond) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Diamond not available' });
    }

    const resolvedAt = new Date(diamond.resolved_at);
    const windowEnd = new Date(resolvedAt);
    windowEnd.setDate(windowEnd.getDate() + REDEMPTION_WINDOW_DAYS);
    
    if (new Date() > windowEnd) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Redemption window closed', closed_at: windowEnd });
    }

    const { rows: [holding] } = await client.query(`
      SELECT quantity FROM pcu_balances WHERE user_id = $1 AND diamond_id = $2
    `, [userId, diamondId]);

    if (!holding || holding.quantity < MINIMUM_REDEEM_PCUS) {
      await client.query('ROLLBACK');
      return res.status(403).json({ 
        error: `Need ${MINIMUM_REDEEM_PCUS} PCUs, have ${holding?.quantity || 0}`,
        suggestion: 'Use combine-redeem for coalition redemption'
      });
    }

    const { rows: [existing] } = await client.query(`
      SELECT id FROM redemptions 
      WHERE diamond_id = $1 AND user_id = $2 AND status IN ('pending', 'approved', 'in_transit')
    `, [diamondId, userId]);

    if (existing) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Redemption already in progress' });
    }

    const diamondValue = diamond.graded_value;
    const insuranceFee = insurance_required ? (diamondValue * (INSURANCE_FEE_BPS / 10000)) : 0;
    const deliveryFee = delivery_method === 'insured_shipment' ? JEWELER_DELIVERY_FEE : 0;

    const { rows: [redemption] } = await client.query(`
      INSERT INTO redemptions (
        diamond_id, user_id, jeweler_id, pcu_quantity, redemption_type,
        delivery_address, delivery_method, insurance_required,
        insurance_fee, delivery_fee, status, requested_at, window_closes_at
      ) VALUES ($1, $2, $3, $4, 'single', $5, $6, $7, $8, $9, 'pending', NOW(), $10)
      RETURNING *
    `, [
      diamondId, userId, diamond.jeweler_id, holding.quantity,
      delivery_address, delivery_method, insurance_required,
      insuranceFee, deliveryFee, windowEnd
    ]);

    await client.query(`
      UPDATE pcu_balances SET reserved_for_redemption = true WHERE user_id = $1 AND diamond_id = $2
    `, [userId, diamondId]);

    await client.query('COMMIT');

    res.status(201).json({
      redemption_id: redemption.id,
      pcus_redeemed: holding.quantity,
      total_fees: insuranceFee + deliveryFee,
      window_closes_at: windowEnd
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Redemption request failed' });
  } finally {
    client.release();
  }
});

// ===== MULTI-SIGNATURE REDEMPTION (v1.1) =====

router.post('/diamonds/:diamondId/combine-redeem', requireAuth, [
  body('partners').isArray({ min: 1, max: 4 }),
  body('designated_recipient').isUUID(),
  body('delivery_address').isLength({ min: 10 }),
  body('delivery_method').isIn(['jeweler_pickup', 'insured_shipment']),
  body('cash_distribution').isIn(['pro_rata', 'equal', 'custom'])
], async (req, res) => {
  const { diamondId } = req.params;
  const { partners, designated_recipient, delivery_address, delivery_method, cash_distribution } = req.body;
  const userId = req.user.id;

  // Include self in coalition
  const allMembers = [userId, ...partners];
  const uniqueMembers = [...new Set(allMembers)];

  if (uniqueMembers.length < 2) {
    return res.status(400).json({ error: 'Coalition requires at least 2 unique members' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify all members have PCUs
    const { rows: holdings } = await client.query(`
      SELECT user_id, quantity FROM pcu_balances 
      WHERE diamond_id = $1 AND user_id = ANY($2) AND reserved_for_redemption = false
    `, [diamondId, uniqueMembers]);

    if (holdings.length !== uniqueMembers.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'Some members have no PCUs or already reserved',
        missing: uniqueMembers.filter(m => !holdings.find(h => h.user_id === m))
      });
    }

    const totalPCUs = holdings.reduce((sum, h) => sum + parseInt(h.quantity), 0);

    const { rows: [diamond] } = await client.query(`SELECT total_pcus FROM diamonds d JOIN ipos i ON d.id = i.diamond_id WHERE d.id = $1`, [diamondId]);
    const requiredPCUs = Math.ceil(diamond.total_pcus * 0.505); // 50.5%

    if (totalPCUs < requiredPCUs) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: `Need ${requiredPCUs} PCUs, coalition has ${totalPCUs}`,
        shortfall: requiredPCUs - totalPCUs
      });
    }

    // Verify designated recipient is in coalition
    if (!uniqueMembers.includes(designated_recipient)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Designated recipient must be coalition member' });
    }

    const { rows: [coalition] } = await client.query(`
      INSERT INTO redemption_coalitions (
        diamond_id, total_pcus, designated_recipient, delivery_address, 
        delivery_method, cash_distribution_method, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'forming', NOW())
      RETURNING *
    `, [diamondId, totalPCUs, designated_recipient, delivery_address, delivery_method, cash_distribution]);

    // Add all members
    for (const member of uniqueMembers) {
      const memberHolding = holdings.find(h => h.user_id === member);
      await client.query(`
        INSERT INTO coalition_members (coalition_id, user_id, pcu_contribution, status)
        VALUES ($1, $2, $3, 'pending_confirmation')
      `, [coalition.id, member, memberHolding.quantity]);
    }

    // Reserve PCUs
    await client.query(`
      UPDATE pcu_balances SET reserved_for_redemption = true 
      WHERE diamond_id = $1 AND user_id = ANY($2)
    `, [diamondId, uniqueMembers]);

    await client.query('COMMIT');

    res.status(201).json({
      coalition_id: coalition.id,
      members: uniqueMembers.length,
      total_pcus: totalPCUs,
      designated_recipient,
      status: 'forming',
      message: 'All members must confirm within 24 hours'
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Coalition formation failed' });
  } finally {
    client.release();
  }
});

// Confirm coalition membership
router.post('/coalitions/:coalitionId/confirm', requireAuth, async (req, res) => {
  const { coalitionId } = req.params;
  const userId = req.user.id;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [member] } = await client.query(`
      UPDATE coalition_members 
      SET status = 'confirmed', confirmed_at = NOW()
      WHERE coalition_id = $1 AND user_id = $2 AND status = 'pending_confirmation'
      RETURNING *
    `, [coalitionId, userId]);

    if (!member) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not a pending member of this coalition' });
    }

    // Check if all confirmed
    const { rows: [status] } = await client.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed
      FROM coalition_members
      WHERE coalition_id = $1
    `, [coalitionId]);

    if (parseInt(status.total) === parseInt(status.confirmed)) {
      // Activate redemption
      await client.query(`
        UPDATE redemption_coalitions 
        SET status = 'active', activated_at = NOW()
        WHERE id = $1
      `, [coalitionId]);

      // Create redemption record
      const { rows: [coalition] } = await client.query(`SELECT * FROM redemption_coalitions WHERE id = $1`, [coalitionId]);
      
      await client.query(`
        INSERT INTO redemptions (
          diamond_id, coalition_id, user_id, jeweler_id, pcu_quantity, redemption_type,
          delivery_address, delivery_method, status, requested_at
        ) SELECT 
          diamond_id, id, designated_recipient, 
          (SELECT jeweler_id FROM diamonds WHERE id = coalition.diamond_id),
          total_pcus, 'coalition', delivery_address, delivery_method, 'pending', NOW()
        FROM redemption_coalitions
        WHERE id = $1
      `, [coalitionId]);
    }

    await client.query('COMMIT');

    res.json({
      confirmed: true,
      coalition_ready: parseInt(status.total) === parseInt(status.confirmed),
      members_confirmed: `${status.confirmed}/${status.total}`
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Confirmation failed' });
  } finally {
    client.release();
  }
});

// ===== REDEMPTION MARKETPLACE (v1.1) =====

router.post('/redemptions/:redemptionId/transfer-right', requireAuth, [
  body('to_user_id').isUUID(),
  body('price').isFloat({ min: 0 })
], async (req, res) => {
  const { redemptionId } = req.params;
  const { to_user_id, price } = req.body;
  const from_user_id = req.user.id;

  if (from_user_id === to_user_id) {
    return res.status(400).json({ error: 'Cannot transfer to self' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [redemption] } = await client.query(`
      SELECT r.*, c.designated_recipient, rc.user_id as coalition_recipient
      FROM redemptions r
      LEFT JOIN redemption_coalitions c ON r.coalition_id = c.id
      LEFT JOIN coalition_members rc ON c.id = rc.coalition_id AND rc.user_id = $2
      WHERE r.id = $1 AND (r.user_id = $2 OR rc.user_id = $2)
      AND r.status IN ('pending', 'approved')
    `, [redemptionId, from_user_id]);

    if (!redemption) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Redemption not found or not transferable' });
    }

    // For coalition redemptions, only designated recipient can transfer
    if (redemption.redemption_type === 'coalition' && 
        redemption.designated_recipient !== from_user_id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only designated recipient can transfer coalition redemption' });
    }

    // Create transfer listing
    const { rows: [listing] } = await client.query(`
      INSERT INTO redemption_right_listings (
        redemption_id, from_user_id, to_user_id, price, status, created_at
      ) VALUES ($1, $2, $3, $4, 'pending_acceptance', NOW())
      RETURNING *
    `, [redemptionId, from_user_id, to_user_id, price]);

    await client.query('COMMIT');

    res.status(201).json({
      listing_id: listing.id,
      redemption_id: redemptionId,
      offered_to: to_user_id,
      price,
      status: 'pending_acceptance',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Transfer listing failed' });
  } finally {
    client.release();
  }
});

// Accept redemption right transfer
router.post('/redemption-listings/:listingId/accept', requireAuth, async (req, res) => {
  const { listingId } = req.params;
  const userId = req.user.id;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [listing] } = await client.query(`
      SELECT * FROM redemption_right_listings 
      WHERE id = $1 AND to_user_id = $2 AND status = 'pending_acceptance'
    `, [listingId, userId]);

    if (!listing) {
      await client.query('ROLLBACK');
      return res.status(404). json({ error: 'Listing not found or not offered to you' });
    }

    // Process payment (simplified - integrate with payment processor)
    // ...

    // Transfer redemption ownership
    await client.query(`
      UPDATE redemptions SET user_id = $2 WHERE id = $1
    `, [listing.redemption_id, userId]);

    await client.query(`
      UPDATE redemption_right_listings SET status = 'completed', completed_at = NOW() WHERE id = $1
    `, [listingId]);

    await client.query('COMMIT');

    res.json({ success: true, redemption_transferred: listing.redemption_id });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Acceptance failed' });
  } finally {
    client.release();
  }
});

// ===== CASH SETTLEMENT =====

router.post('/redemptions/:redemptionId/cash', requireAuth, async (req, res) => {
  const { redemptionId } = req.params;
  const userId = req.user.id;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [redemption] } = await client.query(`
      SELECT r.*, gv.graded_value / i.total_pcus as value_per_pcu
      FROM redemptions r
      JOIN diamonds d ON r.diamond_id = d.id
      JOIN graded_valuations gv ON d.id = gv.diamond_id
      JOIN ipos i ON d.id = i.diamond_id
      WHERE r.id = $1 AND (r.user_id = $2 OR EXISTS (
        SELECT 1 FROM redemption_coalitions c 
        JOIN coalition_members cm ON c.id = cm.coalition_id
        WHERE c.id = r.coalition_id AND cm.user_id = $2
      ))
      AND r.status IN ('pending', 'approved')
    `, [redemptionId, userId]);

    if (!redemption) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Redemption not found' });
    }

    // For coalitions, calculate individual share
    let personalPCUs, personalShare;
    if (redemption.redemption_type === 'coalition') {
      const { rows: [member] } = await client.query(`
        SELECT pcu_contribution FROM coalition_members 
        WHERE coalition_id = $1 AND user_id = $2
      `, [redemption.coalition_id, userId]);
      personalPCUs = member.pcu_contribution;
      personalShare = personalPCUs / redemption.pcu_quantity;
    } else {
      personalPCUs = redemption.pcu_quantity;
      personalShare = 1;
    }

    const grossValue = personalPCUs * redemption.value_per_pcu;
    const penalty = grossValue * (CASH_PENALTY_BPS / 10000);
    const netValue = (grossValue * personalShare) - penalty - (redemption.total_fees * personalShare);

    await client.query(`
      UPDATE redemptions SET status = 'cash_settled', settlement_type = 'cash' WHERE id = $1
    `, [redemptionId]);

    // Credit user
    await client.query(`
      INSERT INTO user_balances (user_id, balance, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE SET balance = user_balances.balance + $2
    `, [userId, netValue]);

    // Burn PCUs
    await client.query(`
      DELETE FROM pcu_balances WHERE user_id = $1 AND diamond_id = (SELECT diamond_id FROM redemptions WHERE id = $2)
    `, [userId, redemptionId]);

    await client.query('COMMIT');

    res.json({ settlement_type: 'cash', net_received: netValue, penalty });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Cash settlement failed' });
  } finally {
    client.release();
  }
});

// ===== JEWELER FULFILLMENT =====

router.post('/redemptions/:redemptionId/fulfill', requireJeweler, [
  body('tracking_number').optional(),
  body('scheduled_date').isISO8601()
], async (req, res) => {
  const { redemptionId } = req.params;
  const { tracking_number, scheduled_date } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [redemption] } = await client.query(`
      SELECT r.*, d.jeweler_id FROM redemptions r
      JOIN diamonds d ON r.diamond_id = d.id
      WHERE r.id = $1 AND r.status = 'pending'
    `, [redemptionId]);

    if (!redemption || redemption.jeweler_id !== req.jeweler.id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found or unauthorized' });
    }

    await client.query(`
      UPDATE redemptions SET status = 'approved', tracking_number = $2, scheduled_delivery_date = $3
      WHERE id = $1
    `, [redemptionId, tracking_number || null, scheduled_date]);

    await client.query(`
      UPDATE jeweler_payments SET status = 'released', released_at = NOW()
      WHERE ipo_id = (SELECT id FROM ipos WHERE diamond_id = $1 LIMIT 1) AND status = 'held'
    `, [redemption.diamond_id]);

    await client.query('COMMIT');

    res.json({ status: 'approved', scheduled_delivery: scheduled_date });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Fulfillment failed' });
  } finally {
    client.release();
  }
});

// ===== AUTOMATED LIQUIDATION (v1.1) =====

router.post('/admin/diamonds/:diamondId/auction', async (req, res) => {
  const { diamondId } = req.params;
  const { auction_house = 'sothebys', reserve_price, description } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [diamond] } = await client.query(`
      SELECT d.*, gv.graded_value FROM diamonds d
      JOIN graded_valuations gv ON d.id = gv.diamond_id
      WHERE d.id = $1 AND d.status IN ('resolved', 'pending_liquidation')
    `, [diamondId]);

    if (!diamond) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Diamond not eligible' });
    }

    const finalReserve = reserve_price || diamond.graded_value * 0.7;

    const { rows: [auction] } = await client.query(`
      INSERT INTO auction_listings (
        diamond_id, auction_house, reserve_price, description, 
        status, submitted_at, estimated_close_date
      ) VALUES ($1, $2, $3, $4, 'submitted', NOW(), NOW() + INTERVAL '30 days')
      RETURNING *
    `, [diamondId, auction_house, finalReserve, description]);

    await client.query(`UPDATE diamonds SET status = 'at_auction' WHERE id = $1`, [diamondId]);

    // Submit to auction house API (async)
    submitToAuctionHouse(auction.id, diamond, auction_house).catch(console.error);

    await client.query('COMMIT');

    res.json({ auction_id: auction.id, auction_house, reserve_price: finalReserve });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Auction submission failed' });
  } finally {
    client.release();
  }
});

// Auction result webhook
router.post('/webhooks/auction-result', async (req, res) => {
  const { auction_id, sale_price, buyer_info, fees } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [auction] } = await client.query(`
      SELECT * FROM auction_listings WHERE id = $1
    `, [auction_id]);

    const netProceeds = sale_price - (fees || 0);

    // Distribute to PCU holders pro-rata
    const { rows: holders } = await client.query(`
      SELECT user_id, quantity FROM pcu_balances WHERE diamond_id = $1
    `, [auction.diamond_id]);

    const totalPCUs = holders.reduce((sum, h) => sum + h.quantity, 0);

    for (const holder of holders) {
      const share = (holder.quantity / totalPCUs) * netProceeds;
      await client.query(`
        INSERT INTO user_balances (user_id, balance, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id) DO UPDATE SET balance = user_balances.balance + $2
      `, [holder.user_id, share]);
    }

    await client.query(`
      UPDATE auction_listings SET 
        status = 'sold', 
        sale_price = $2, 
        net_proceeds = $3,
        sold_at = NOW()
      WHERE id = $1
    `, [auction_id, sale_price, netProceeds]);

    await client.query(`UPDATE diamonds SET status = 'liquidated' WHERE id = $1`, [auction.diamond_id]);

    await client.query('COMMIT');

    res.json({ distributed: true, holders: holders.length, total_distributed: netProceeds });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Distribution failed' });
  } finally {
    client.release();
  }
});

// ===== INSURANCE CLAIMS (v1.1) =====

router.post('/redemptions/:redemptionId/claim-loss', requireAuth, [
  body('claim_type').isIn(['lost_shipment', 'theft', 'damage']),
  body('description').isLength({ min: 20 }),
  body('evidence_urls').isArray()
], async (req, res) => {
  const { redemptionId } = req.params;
  const { claim_type, description, evidence_urls } = req.body;

  const client = await pool.connect();

  try {
    const { rows: [redemption] } = await client.query(`
      SELECT r.*, gv.graded_value, r.insurance_value
      FROM redemptions r
      JOIN diamonds d ON r.diamond_id = d.id
      JOIN graded_valuations gv ON d.id = gv.diamond_id
      WHERE r.id = $1 AND r.user_id = $2 AND r.status = 'in_transit'
    `, [redemptionId, req.user.id]);

    if (!redemption) {
      return res.status(404).json({ error: 'Redemption not found or not eligible' });
    }

    const { rows: [claim] } = await client.query(`
      INSERT INTO redemption_insurance_claims (
        redemption_id, diamond_id, user_id, claim_type, description,
        evidence_urls, claimed_amount, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
      RETURNING *
    `, [
      redemptionId, redemption.diamond_id, req.user.id,
      claim_type, description, JSON.stringify(evidence_urls),
      redemption.insurance_value || redemption.graded_value * 0.8
    ]);

    res.status(201).json({
      claim_id: claim.id,
      claimed_amount: claim.claimed_amount,
      status: 'pending',
      message: 'Claim submitted. Review within 10 business days.'
    });

  } catch (err) {
    res.status(500).json({ error: 'Claim submission failed' });
  } finally {
    client.release();
  }
});

// ===== ANALYTICS (v1.1) =====

router.get('/analytics/redemptions', async (req, res) => {
  const { jeweler_id, days = 30 } = req.query;

  let where = 'WHERE r.requested_at > NOW() - INTERVAL $1 days';
  const params = [days];

  if (jeweler_id) {
    where += ` AND r.jeweler_id = $${params.length + 1}`;
    params.push(jeweler_id);
  }

  const { rows: [summary] } = await pool.query(`
    SELECT 
      COUNT(*) as total_redemptions,
      COUNT(CASE WHEN r.settlement_type = 'physical' THEN 1 END) as physical_redemptions,
      COUNT(CASE WHEN r.settlement_type = 'cash' THEN 1 END) as cash_redemptions,
      COUNT(CASE WHEN r.redemption_type = 'coalition' THEN 1 END) as coalition_redemptions,
      AVG(CASE WHEN r.delivered_at IS NOT NULL 
        THEN EXTRACT(EPOCH FROM (r.delivered_at - r.requested_at))/86400 
      END) as avg_fulfillment_days,
      SUM(r.gross_value) as total_gross_value,
      SUM(r.net_value) as total_net_value,
      SUM(r.insurance_fee + r.delivery_fee) as total_fees,
      AVG(r.penalty_amount) as avg_cash_penalty
    FROM redemptions r
    ${where}
  `, params);

  const { rows: jewelerPerformance } = await pool.query(`
    SELECT 
      j.business_name,
      COUNT(*) as redemptions_fulfilled,
      AVG(CASE WHEN r.status = 'delivered' THEN 5 
               WHEN r.status = 'cash_settled' THEN 4
               WHEN r.status = 'approved' THEN 3
               ELSE 1 
          END) as fulfillment_score,
      COUNT(CASE WHEN r.delivered_at > r.scheduled_delivery_date THEN 1 END) as late_deliveries
    FROM redemptions r
    JOIN jewelers j ON r.jeweler_id = j.id
    ${where}
    GROUP BY j.id, j.business_name
    ORDER BY fulfillment_score DESC
  `, params);

  res.json({
    summary: summary,
    jeweler_performance: jewelerPerformance,
    cash_vs_physical_ratio: summary.cash_redemptions / (summary.physical_redemptions + summary.cash_redemptions),
    period_days: days
  });
});

// ===== QUERIES =====

router.get('/my/redemptions', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT 
      r.*,
      d.final_carat, d.final_color, d.final_clarity, d.final_cut,
      gv.graded_value / i.total_pcus as value_per_pcu,
      j.business_name as jeweler_name,
      c.designated_recipient as coalition_recipient
    FROM redemptions r
    JOIN diamonds d ON r.diamond_id = d.id
    JOIN ipos i ON d.id = i.diamond_id
    JOIN jewelers j ON r.jeweler_id = j.id
    LEFT JOIN graded_valuations gv ON d.id = gv.diamond_id
    LEFT JOIN redemption_coalitions c ON r.coalition_id = c.id
    WHERE r.user_id = $1 OR EXISTS (
      SELECT 1 FROM coalition_members cm 
      WHERE cm.coalition_id = r.coalition_id AND cm.user_id = $1
    )
    ORDER BY r.requested_at DESC
  `, [req.user.id]);

  res.json({ redemptions: rows });
});

export default router;
