// brick-08-admin.js
// PCAux Diamond Platform - Brick #8: Admin Dashboard
// Diamond-specific: 4C management, grader APIs, dispute resolution

import express from 'express';
import { Pool } from 'pg';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const router = express.Router();
const pool = new Pool();
const JWT_SECRET = process.env.JWT_SECRET || 'pcaux-admin-secret';

// ===== ADMIN AUTH =====

// Super admin login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { rows: [admin] } = await pool.query(
      'SELECT * FROM admins WHERE email = $1 AND active = true',
      [email]
    );

    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token, role: admin.role, expiresIn: '8h' });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Admin middleware
const requireAdmin = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }

  try {
    const token = auth.split(' ')[1];
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const requireSuper = (req, res, next) => {
  if (req.admin?.role !== 'super') {
    return res.status(403).json({ error: 'Super admin required' });
  }
  next();
};

// ===== DASHBOARD OVERVIEW =====

router.get('/dashboard', requireAdmin, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [
      jewelers,
      diamonds,
      ipos,
      trades,
      gradings,
      redemptions
    ] = await Promise.all([
      // Jeweler stats
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
          COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as new_30d,
          AVG(quality_king_score) as avg_score
        FROM jewelers
      `),
      
      // Diamond stats
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'draft' THEN 1 END) as draft,
          COUNT(CASE WHEN status = 'verified' THEN 1 END) as verified,
          COUNT(CASE WHEN status = 'listing' THEN 1 END) as listing,
          COUNT(CASE WHEN status = 'grading' THEN 1 END) as grading,
          COUNT(CASE WHEN status = 'graded' THEN 1 END) as graded,
          COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved,
          COUNT(CASE WHEN status = 'fully_redeemed' THEN 1 END) as redeemed,
          SUM(CASE WHEN status IN ('graded', 'resolved') THEN final_carat ELSE 0 END) as total_carats_graded
        FROM diamonds
      `),
      
      // IPO stats
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'open' THEN 1 END) as open,
          COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed,
          SUM(CASE WHEN status = 'closed' THEN total_value ELSE 0 END) as total_raised,
          AVG(CASE WHEN status = 'closed' THEN sold_pcus::FLOAT / total_pcus END) as avg_fill_rate
        FROM ipos
        WHERE created_at > NOW() - INTERVAL '30 days'
      `),
      
      // Trading stats
      pool.query(`
        SELECT 
          COUNT(*) as total_fills,
          SUM(quantity) as total_pcus_traded,
          SUM(price * quantity) as total_volume,
          SUM(buyer_fee + seller_fee) as total_fees
        FROM fills
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `),
      
      // Grading stats
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'submitted' THEN 1 END) as pending,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
          AVG(final_carat / estimated_carat) as avg_carat_ratio,
          AVG(CASE 
            WHEN estimated_color = final_color AND estimated_clarity = final_clarity THEN 1 
            ELSE 0 
          END) as perfect_estimate_rate
        FROM grading_submissions gs
        JOIN diamonds d ON gs.diamond_id = d.id
        WHERE gs.created_at > NOW() - INTERVAL '30 days'
      `),
      
      // Redemption stats
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
          COUNT(CASE WHEN settlement_type = 'cash' THEN 1 END) as cash_settlements,
          SUM(net_value) as total_settled
        FROM redemptions
        WHERE requested_at > NOW() - INTERVAL '30 days'
      `)
    ]);

    res.json({
      date: today,
      jewelers: jewelers.rows[0],
      diamonds: diamonds.rows[0],
      ipos: ipos.rows[0],
      trades: trades.rows[0],
      gradings: gradings.rows[0],
      redemptions: redemptions.rows[0],
      platform_health: calculateHealthScore(jewelers.rows[0], diamonds.rows[0], ipos.rows[0])
    });
  } catch (err) {
    res.status(500).json({ error: 'Dashboard load failed' });
  }
});

function calculateHealthScore(jewelers, diamonds, ipos) {
  const jScore = Math.min(jewelers.active / 10, 1) * 25; // Need 10+ active jewelers
  const dScore = Math.min(diamonds.listing / 20, 1) * 25; // Need 20+ listing diamonds
  const iScore = (ipos.avg_fill_rate || 0) * 25; // Fill rate
  const vScore = Math.min(parseFloat(ipos.total_raised || 0) / 100000, 1) * 25; // $100K monthly
  
  return {
    total: Math.round(jScore + dScore + iScore + vScore),
    components: {
      jeweler_supply: Math.round(jScore),
      inventory_depth: Math.round(dScore),
      market_demand: Math.round(iScore),
      volume_velocity: Math.round(vScore)
    }
  };
}

// ===== DIAMOND MANAGEMENT =====

// List all diamonds with filters
router.get('/diamonds', requireAdmin, async (req, res) => {
  const { status, jeweler_id, grader, min_carat, max_carat, limit = 50, offset = 0 } = req.query;

  try {
    let where = 'WHERE 1=1';
    const params = [];

    if (status) {
      where += ` AND d.status = $${params.length + 1}`;
      params.push(status);
    }
    if (jeweler_id) {
      where += ` AND d.jeweler_id = $${params.length + 1}`;
      params.push(jeweler_id);
    }
    if (grader) {
      where += ` AND d.grader = $${params.length + 1}`;
      params.push(grader);
    }
    if (min_carat) {
      where += ` AND d.estimated_carat >= $${params.length + 1}`;
      params.push(min_carat);
    }
    if (max_carat) {
      where += ` AND d.estimated_carat <= $${params.length + 1}`;
      params.push(max_carat);
    }

    const { rows } = await pool.query(`
      SELECT 
        d.*,
        j.business_name as jeweler_name,
        j.quality_king_tier as jeweler_tier,
        i.ipo_price, i.total_pcus, i.sold_pcus, i.status as ipo_status,
        gv.total_multiplier, gv.graded_value
      FROM diamonds d
      JOIN jewelers j ON d.jeweler_id = j.id
      LEFT JOIN ipos i ON d.id = i.diamond_id
      LEFT JOIN graded_valuations gv ON d.id = gv.diamond_id
      ${where}
      ORDER BY d.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    // Parse images
    rows.forEach(r => { if (r.images) r.images = JSON.parse(r.images); });

    res.json({ diamonds: rows, limit, offset });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load diamonds' });
  }
});

// Get diamond details with full audit trail
router.get('/diamonds/:diamondId', requireAdmin, async (req, res) => {
  const { diamondId } = req.params;

  try {
    const [diamond, verifications, subscriptions, orders, fills, redemptions, accuracy] = await Promise.all([
      // Core diamond data
      pool.query(`
        SELECT d.*, j.business_name, j.email as jeweler_email, j.quality_king_score
        FROM diamonds d
        JOIN jewelers j ON d.jeweler_id = j.id
        WHERE d.id = $1
      `, [diamondId]),
      
      // Sleeve verifications
      pool.query(`SELECT * FROM sleeve_verifications WHERE diamond_id = $1`, [diamondId]),
      
      // IPO subscriptions
      pool.query(`
        SELECT s.*, u.display_name, u.email
        FROM ipo_subscriptions s
        JOIN users u ON s.user_id = u.id
        WHERE s.diamond_id = $1
      `, [diamondId]),
      
      // Trading orders
      pool.query(`SELECT * FROM orders WHERE diamond_id = $1`, [diamondId]),
      
      // Fills
      pool.query(`SELECT * FROM fills WHERE diamond_id = $1`, [diamondId]),
      
      // Redemptions
      pool.query(`SELECT * FROM redemptions WHERE diamond_id = $1`, [diamondId]),
      
      // Accuracy log
      pool.query(`SELECT * FROM grading_accuracy_logs WHERE diamond_id = $1`, [diamondId])
    ]);

    if (!diamond.rows[0]) return res.status(404).json({ error: 'Diamond not found' });

    res.json({
      diamond: diamond.rows[0],
      audit_trail: {
        verifications: verifications.rows,
        subscriptions: subscriptions.rows,
        orders: orders.rows,
        fills: fills.rows,
        redemptions: redemptions.rows,
        accuracy: accuracy.rows[0]
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load diamond details' });
  }
});

// Manual 4C adjustment (for data corrections)
router.patch('/diamonds/:diamondId/4c', requireAdmin, [
  body('field').isIn(['estimated_carat', 'estimated_color', 'estimated_clarity', 'estimated_cut', 'final_carat', 'final_color', 'final_clarity', 'final_cut']),
  body('value').exists(),
  body('reason').isLength({ min: 10 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { diamondId } = req.params;
  const { field, value, reason } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Log the change
    await client.query(`
      INSERT INTO diamond_4c_changes (diamond_id, field, old_value, new_value, reason, admin_id, changed_at)
      SELECT $1, $2, ${field}, $3, $4, $5, NOW()
      FROM diamonds WHERE id = $1
    `, [diamondId, field, value, reason, req.admin.id]);

    // Apply change
    await client.query(`UPDATE diamonds SET ${field} = $2, updated_at = NOW() WHERE id = $1`, [diamondId, value]);

    await client.query('COMMIT');

    res.json({ message: '4C data updated', field, value, reason });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Update failed' });
  } finally {
    client.release();
  }
});

// ===== GRADER API MANAGEMENT =====

// List grader API configurations
router.get('/grader-apis', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        ga.*,
        COUNT(gs.id) as pending_submissions,
        AVG(EXTRACT(EPOCH FROM (gs.completed_at - gs.submitted_at))/3600) as avg_turnaround_hours
      FROM grader_apis ga
      LEFT JOIN grading_submissions gs ON ga.grader_name = gs.grader AND gs.status = 'completed'
      GROUP BY ga.id
    `);

    res.json({ graders: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load grader APIs' });
  }
});

// Update grader API config
router.patch('/grader-apis/:graderId', requireSuper, [
  body('api_endpoint').optional().isURL(),
  body('api_key').optional().isLength({ min: 10 }),
  body('active').optional().isBoolean(),
  body('cost_standard').optional().isFloat(),
  body('cost_rush').optional().isFloat(),
  body('avg_turnaround_days').optional().isFloat()
], async (req, res) => {
  const { graderId } = req.params;
  const updates = req.body;

  const allowed = ['api_endpoint', 'api_key', 'active', 'cost_standard', 'cost_rush', 'avg_turnaround_days', 'notes'];
  const fields = [];
  const values = [];

  Object.keys(updates).forEach((key, idx) => {
    if (allowed.includes(key)) {
      fields.push(`${key} = $${idx + 1}`);
      values.push(updates[key]);
    }
  });

  if (fields.length === 0) return res.status(400).json({ error: 'No valid fields' });

  values.push(graderId);

  try {
    const { rows } = await pool.query(`
      UPDATE grader_apis 
      SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING *
    `, values);

    res.json({ grader: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// Manual grading result entry (backup if API fails)
router.post('/diamonds/:diamondId/manual-grade', requireSuper, [
  body('certificate_number').isLength({ min: 5 }),
  body('final_carat').isFloat(),
  body('final_color').isIn(['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M']),
  body('final_clarity').isIn(['FL', 'IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2', 'I1', 'I2', 'I3']),
  body('final_cut').isIn(['Ideal', 'Excellent', 'Very Good', 'Good', 'Fair', 'Poor']),
  body('report_url').optional().isURL()
], async (req, res) => {
  const { diamondId } = req.params;
  const data = req.body;

  // This triggers the same logic as the webhook in brick-05
  // Implementation: call the grading result processor directly
  
  res.json({ message: 'Manual grade entry - implement with internal grading processor call' });
});

// ===== DISPUTE RESOLUTION =====

// List disputes
router.get('/disputes', requireAdmin, async (req, res) => {
  const { status = 'open', limit = 20, offset = 0 } = req.query;

  try {
    const { rows } = await pool.query(`
      SELECT 
        d.*,
        u.display_name as user_name,
        u.email as user_email,
        j.business_name as jeweler_name,
        dia.estimated_carat, dia.final_carat,
        gv.total_multiplier
      FROM disputes d
      JOIN users u ON d.user_id = u.id
      JOIN jewelers j ON d.jeweler_id = j.id
      JOIN diamonds dia ON d.diamond_id = dia.id
      LEFT JOIN graded_valuations gv ON dia.id = gv.diamond_id
      WHERE d.status = $1
      ORDER BY d.created_at DESC
      LIMIT $2 OFFSET $3
    `, [status, limit, offset]);

    res.json({ disputes: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load disputes' });
  }
});

// Get dispute details
router.get('/disputes/:disputeId', requireAdmin, async (req, res) => {
  const { disputeId } = req.params;

  try {
    const { rows: [dispute] } = await pool.query(`SELECT * FROM disputes WHERE id = $1`, [disputeId]);
    if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

    const { rows: messages } = await pool.query(`
      SELECT * FROM dispute_messages WHERE dispute_id = $1 ORDER BY created_at
    `, [disputeId]);

    res.json({ dispute, messages });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load dispute' });
  }
});

// Resolve dispute
router.post('/disputes/:disputeId/resolve', requireAdmin, [
  body('resolution').isIn(['user_favor', 'jeweler_favor', 'split', 'refund', 'replacement']),
  body('refund_amount').optional().isFloat(),
  body('notes').isLength({ min: 20 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { disputeId } = req.params;
  const { resolution, refund_amount, notes } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Update dispute
    await client.query(`
      UPDATE disputes 
      SET status = 'resolved', 
          resolution = $2, 
          refund_amount = $3, 
          resolved_by = $4, 
          resolution_notes = $5,
          resolved_at = NOW()
      WHERE id = $1
    `, [disputeId, resolution, refund_amount || 0, req.admin.id, notes]);

    // Execute resolution actions
    if (resolution === 'refund' && refund_amount > 0) {
      // Process refund to user
      const { rows: [dispute] } = await client.query(`SELECT user_id FROM disputes WHERE id = $1`, [disputeId]);
      await client.query(`
        INSERT INTO user_balances (user_id, balance, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id) DO UPDATE SET balance = user_balances.balance + $2
      `, [dispute.user_id, refund_amount]);
    }

    // Penalize jeweler score if they lost
    if (resolution === 'user_favor') {
      await client.query(`
        UPDATE jewelers 
        SET quality_king_score = GREATEST(0, quality_king_score - 50),
            updated_at = NOW()
        WHERE id = (SELECT jeweler_id FROM disputes WHERE id = $1)
      `, [disputeId]);
    }

    await client.query('COMMIT');

    res.json({ message: 'Dispute resolved', resolution, refund_amount });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Resolution failed' });
  } finally {
    client.release();
  }
});

// ===== JEWELER KYB MANAGEMENT =====

// List pending KYB verifications
router.get('/kyb/pending', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        k.*,
        j.business_name, j.email, j.tax_id, j.created_at as registered_at
      FROM kyb_verifications k
      JOIN jewelers j ON k.jeweler_id = j.id
      WHERE k.status = 'pending'
      ORDER BY k.created_at
    `);

    res.json({ verifications: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load verifications' });
  }
});

// Review KYB submission
router.post('/kyb/:kybId/review', requireAdmin, [
  body('decision').isIn(['approve', 'reject']),
  body('notes').optional()
], async (req, res) => {
  const { kybId } = req.params;
  const { decision, notes } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [kyb] } = await client.query(`SELECT * FROM kyb_verifications WHERE id = $1`, [kybId]);

    const newStatus = decision === 'approve' ? 'verified' : 'rejected';
    const jewelerStatus = decision === 'approve' ? 'active' : 'rejected';

    await client.query(`
      UPDATE kyb_verifications 
      SET status = $2, reviewer_notes = $3, reviewed_by = $4, reviewed_at = NOW()
      WHERE id = $1
    `, [kybId, newStatus, notes || null, req.admin.id]);

    await client.query(`
      UPDATE jewelers 
      SET kyb_status = $2, status = $3, kyb_verified_at = NOW()
      WHERE id = $1
    `, [kyb.jeweler_id, newStatus, jewelerStatus]);

    await client.query('COMMIT');

    res.json({ message: `Jeweler KYB ${decision}d`, jeweler_id: kyb.jeweler_id });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Review failed' });
  } finally {
    client.release();
  }
});

// ===== ADMIN MANAGEMENT =====

// Create new admin (super only)
router.post('/admins', requireSuper, [
  body('email').isEmail(),
  body('password').isLength({ min: 12 }),
  body('role').isIn(['admin', 'super']),
  body('name').trim().isLength({ min: 2 })
], async (req, res) => {
  const { email, password, role, name } = req.body;
  const hash = await bcrypt.hash(password, 12);

  try {
    const { rows: [admin] } = await pool.query(`
      INSERT INTO admins (email, password_hash, role, name, active, created_at)
      VALUES ($1, $2, $3, $4, true, NOW())
      RETURNING id, email, role, name, created_at
    `, [email, hash, role, name]);

    res.status(201).json(admin);
  } catch (err) {
    res.status(409).json({ error: 'Email already exists' });
  }
});

export default router;
