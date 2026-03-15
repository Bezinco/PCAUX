// brick-05-grading.js
// PCAux Diamond Platform - Brick #5: Grading Pipeline (CGL/GIA)
// API integration, result oracle, grade reveal, multiplier application
// Enhanced with: grading dashboard, timeline estimates, confidence intervals, insurance claims

import express from 'express';
import { Pool } from 'pg';
import { body, validationResult } from 'express-validator';
import { requireJeweler, requireAuth } from './brick-01-auth.js';
import axios from 'axios';

const router = express.Router();
const pool = new Pool();

// Grader API configurations
const CGL_API = {
  baseUrl: process.env.CGL_API_URL || 'https://api.cgl.org/v1',
  key: process.env.CGL_API_KEY
};

const GIA_API = {
  baseUrl: process.env.GIA_API_URL || 'https://api.gia.edu/v1',
  key: process.env.GIA_API_KEY
};

// Grading timeline estimates (days)
const GRADING_TIMES = {
  standard: { CGL: 14, GIA: 21 },
  rush: { CGL: 5, GIA: 7 }
};

// Grading costs
const GRADING_COST_CGL = 150;
const GRADING_COST_GIA = 250;
const RUSH_FEE = 100;
const SHIPPING_INSURANCE = 25;

// Multiplier matrix
const GRADE_MULTIPLIERS = {
  color: {
    'D': { 'D': 1.0, 'E': 0.85, 'F': 0.75, 'G': 0.65, 'H': 0.55, 'I': 0.45, 'J': 0.35 },
    'E': { 'D': 1.3, 'E': 1.0, 'F': 0.85, 'G': 0.75, 'H': 0.65, 'I': 0.55, 'J': 0.45 },
    'F': { 'D': 1.5, 'E': 1.2, 'F': 1.0, 'G': 0.85, 'H': 0.75, 'I': 0.65, 'J': 0.55 },
    'G': { 'D': 1.8, 'E': 1.4, 'F': 1.15, 'G': 1.0, 'H': 0.85, 'I': 0.75, 'J': 0.65 },
    'H': { 'D': 2.2, 'E': 1.7, 'F': 1.3, 'G': 1.15, 'H': 1.0, 'I': 0.85, 'J': 0.75 },
    'I': { 'D': 2.8, 'E': 2.1, 'F': 1.6, 'G': 1.3, 'H': 1.15, 'I': 1.0, 'J': 0.85 },
    'J': { 'D': 3.5, 'E': 2.6, 'F': 2.0, 'G': 1.6, 'H': 1.3, 'I': 1.15, 'J': 1.0 },
    'unknown': { 'D': 2.5, 'E': 2.0, 'F': 1.6, 'G': 1.3, 'H': 1.1, 'I': 0.9, 'J': 0.75 }
  },
  clarity: {
    'FL': { 'FL': 1.0, 'IF': 0.9, 'VVS1': 0.8, 'VVS2': 0.7, 'VS1': 0.6, 'VS2': 0.5 },
    'IF': { 'FL': 1.15, 'IF': 1.0, 'VVS1': 0.9, 'VVS2': 0.8, 'VS1': 0.7, 'VS2': 0.6 },
    'VVS1': { 'FL': 1.3, 'IF': 1.15, 'VVS1': 1.0, 'VVS2': 0.9, 'VS1': 0.8, 'VS2': 0.7 },
    'VVS2': { 'FL': 1.45, 'IF': 1.25, 'VVS1': 1.1, 'VVS2': 1.0, 'VS1': 0.9, 'VS2': 0.8 },
    'VS1': { 'FL': 1.65, 'IF': 1.4, 'VVS1': 1.25, 'VVS2': 1.1, 'VS1': 1.0, 'VS2': 0.9 },
    'VS2': { 'FL': 1.85, 'IF': 1.6, 'VVS1': 1.4, 'VVS2': 1.25, 'VS1': 1.1, 'VS2': 1.0 },
    'SI1': { 'FL': 2.2, 'IF': 1.9, 'VVS1': 1.65, 'VVS2': 1.45, 'VS1': 1.25, 'VS2': 1.1 },
    'SI2': { 'FL': 2.8, 'IF': 2.4, 'VVS1': 2.0, 'VVS2': 1.75, 'VS1': 1.5, 'VS2': 1.3 },
    'unknown': { 'FL': 2.0, 'IF': 1.7, 'VVS1': 1.5, 'VVS2': 1.3, 'VS1': 1.1, 'VS2': 1.0 }
  },
  cut: {
    'Ideal': { 'Ideal': 1.0, 'Excellent': 0.9, 'Very Good': 0.75, 'Good': 0.6 },
    'Excellent': { 'Ideal': 1.15, 'Excellent': 1.0, 'Very Good': 0.85, 'Good': 0.7 },
    'Very Good': { 'Ideal': 1.35, 'Excellent': 1.15, 'Very Good': 1.0, 'Good': 0.85 },
    'Good': { 'Ideal': 1.6, 'Excellent': 1.4, 'Very Good': 1.15, 'Good': 1.0 },
    'unknown': { 'Ideal': 1.3, 'Excellent': 1.15, 'Very Good': 1.0, 'Good': 0.85 }
  }
};

// ===== GRADING DASHBOARD (v1.1) =====

// Jeweler grading queue
router.get('/jeweler/grading-queue', requireJeweler, async (req, res) => {
  const { status = 'all' } = req.query;

  let where = 'WHERE d.jeweler_id = $1';
  const params = [req.jeweler.id];

  if (status !== 'all') {
    where += ` AND gs.status = $${params.length + 1}`;
    params.push(status);
  }

  const { rows } = await pool.query(`
    SELECT 
      gs.id,
      gs.diamond_id,
      gs.grader,
      gs.service_level,
      gs.status,
      gs.certificate_number,
      gs.final_color,
      gs.final_clarity,
      gs.final_cut,
      gs.final_carat,
      d.shape,
      d.estimated_carat,
      d.estimated_color,
      d.estimated_clarity,
      d.estimated_cut,
      gs.submitted_at,
      gs.completed_at,
      EXTRACT(EPOCH FROM (NOW() - gs.submitted_at))/86400 as days_ago,
      EXTRACT(EPOCH FROM (gs.completed_at - gs.submitted_at))/86400 as days_to_complete,
      CASE 
        WHEN gs.service_level = 'rush' THEN ${GRADING_TIMES.rush.CGL}
        ELSE ${GRADING_TIMES.standard.CGL}
      END as expected_days_cgl,
      CASE 
        WHEN gs.service_level = 'rush' THEN ${GRADING_TIMES.rush.GIA}
        ELSE ${GRADING_TIMES.standard.GIA}
      END as expected_days_gia,
      gv.total_multiplier
    FROM grading_submissions gs
    JOIN diamonds d ON gs.diamond_id = d.id
    LEFT JOIN graded_valuations gv ON gs.id = gv.submission_id
    ${where}
    ORDER BY gs.submitted_at DESC
  `, params);

  // Add timeline status
  rows.forEach(row => {
    const expectedDays = row.grader === 'GIA' 
      ? (row.service_level === 'rush' ? GRADING_TIMES.rush.GIA : GRADING_TIMES.standard.GIA)
      : (row.service_level === 'rush' ? GRADING_TIMES.rush.CGL : GRADING_TIMES.standard.CGL);
    
    row.timeline_status = row.completed_at 
      ? 'completed'
      : row.days_ago > expectedDays * 1.5 
        ? 'overdue' 
        : row.days_ago > expectedDays 
          ? 'at_risk' 
          : 'on_track';
    
    row.expected_completion = row.submitted_at 
      ? new Date(new Date(row.submitted_at).getTime() + expectedDays * 86400000).toISOString()
      : null;
  });

  res.json({ 
    queue: rows,
    summary: {
      total: rows.length,
      pending: rows.filter(r => !r.completed_at).length,
      completed: rows.filter(r => r.completed_at).length,
      overdue: rows.filter(r => r.timeline_status === 'overdue').length,
      avg_multiplier: rows.filter(r => r.total_multiplier).reduce((a, b) => a + parseFloat(b.total_multiplier), 0) / rows.filter(r => r.total_multiplier).length || null
    }
  });
});

// Confidence intervals for jeweler (v1.1)
router.get('/jeweler/multiplier-confidence', requireJeweler, async (req, res) => {
  const { rows: [stats] } = await pool.query(`
    SELECT 
      AVG(gv.total_multiplier) as avg_mult,
      STDDEV(gv.total_multiplier) as stddev_mult,
      MIN(gv.total_multiplier) as min_mult,
      MAX(gv.total_multiplier) as max_mult,
      COUNT(*) as sample_size,
      PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY gv.total_multiplier) as p25,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY gv.total_multiplier) as p75
    FROM graded_valuations gv
    JOIN diamonds d ON gv.diamond_id = d.id
    WHERE d.jeweler_id = $1
    AND gv.calculated_at > NOW() - INTERVAL '90 days'
  `, [req.jeweler.id]);

  if (!stats || stats.sample_size === 0) {
    return res.json({ 
      message: 'Insufficient grading history for confidence interval',
      expected_range: '1.2x - 2.0x (platform average)'
    });
  }

  const avg = parseFloat(stats.avg_mult);
  const stddev = parseFloat(stats.stddev_mult) || 0.3;

  res.json({
    jeweler_id: req.jeweler.id,
    sample_size: parseInt(stats.sample_size),
    statistics: {
      mean: avg.toFixed(2),
      stddev: stddev.toFixed(2),
      min: parseFloat(stats.min_mult).toFixed(2),
      max: parseFloat(stats.max_mult).toFixed(2),
      p25: parseFloat(stats.p25).toFixed(2),
      p75: parseFloat(stats.p75).toFixed(2)
    },
    confidence_intervals: {
      '68%': `${(avg - stddev).toFixed(2)}x - ${(avg + stddev).toFixed(2)}x`,
      '95%': `${(avg - 2 * stddev).toFixed(2)}x - ${(avg + 2 * stddev).toFixed(2)}x`
    },
    interpretation: stddev < 0.5 
      ? 'Consistent grading results - reliable estimates'
      : stddev < 1.0
        ? 'Moderate variance - typical for mixed inventory'
        : 'High variance - consider specializing in specific categories'
  });
});

// ===== GRADING SUBMISSION =====

router.post('/diamonds/:diamondId/grade', requireJeweler, [
  body('grader').isIn(['CGL', 'GIA']),
  body('service_level').optional().isIn(['standard', 'rush']),
  body('origin_report').optional().isBoolean(),
  body('insurance_value').optional().isFloat()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { diamondId } = req.params;
  const { grader, service_level = 'standard', origin_report = false, insurance_value } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [diamond] } = await client.query(`
      SELECT d.*, i.ipo_price, i.total_pcus, i.sold_pcus, i.id as ipo_id
      FROM diamonds d
      JOIN ipos i ON d.id = i.diamond_id
      WHERE d.id = $1 AND d.jeweler_id = $2 AND d.status IN ('listing', 'pending_grading')
    `, [diamondId, req.jeweler.id]);

    if (!diamond) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Diamond not found or not ready for grading' });
    }

    if (diamond.sold_pcus < diamond.total_pcus * 0.5) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'IPO must be at least 50% subscribed' });
    }

    const baseCost = grader === 'GIA' ? GRADING_COST_GIA : GRADING_COST_CGL;
    const rushFee = service_level === 'rush' ? RUSH_FEE : 0;
    const originFee = origin_report ? 75 : 0;
    const totalCost = baseCost + rushFee + originFee + SHIPPING_INSURANCE;

    const { rows: [treasury] } = await client.query(`
      SELECT COALESCE(SUM(CASE WHEN status = 'locked' THEN amount ELSE 0 END), 0) as locked,
             COALESCE(SUM(CASE WHEN event_type = 'grading_paid' THEN amount ELSE 0 END), 0) as spent
      FROM treasury_events
      WHERE ipo_id = $1
    `, [diamond.ipo_id]);

    const available = (treasury.locked || 0) - (treasury.spent || 0);
    if (available < totalCost) {
      await client.query('ROLLBACK');
      return res.status(402).json({ required: totalCost, available });
    }

    const { rows: [submission] } = await client.query(`
      INSERT INTO grading_submissions (
        diamond_id, ipo_id, grader, service_level, origin_report_requested,
        cost, status, submitted_at, expected_completion_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'submitted', NOW(), NOW() + INTERVAL '${service_level === 'rush' ? '7 days' : '21 days'}')
      RETURNING *
    `, [diamondId, diamond.ipo_id, grader, service_level, origin_report, totalCost]);

    await client.query(`
      INSERT INTO treasury_events (ipo_id, event_type, amount, status, metadata, created_at)
      VALUES ($1, 'grading_paid', $2, 'locked', $3, NOW())
    `, [diamond.ipo_id, totalCost, JSON.stringify({ submission_id: submission.id, grader })]);

    await client.query(`
      UPDATE diamonds SET status = 'grading', grader = $2, grading_submitted_at = NOW() WHERE id = $1
    `, [diamondId, grader]);

    await client.query(`
      UPDATE sleeves SET status = 'shipping_to_grader', current_diamond_id = NULL WHERE id = $1
    `, [diamond.sleeve_id]);

    const insuranceAmount = insurance_value || (diamond.total_pcus * diamond.ipo_price * 0.8);
    await client.query(`
      INSERT INTO grading_shipments (
        submission_id, from_sleeve, to_grader, grader_address, insurance_value, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'in_transit', NOW())
    `, [
      submission.id,
      diamond.sleeve_id,
      grader,
      grader === 'GIA' ? 'GIA Laboratory, Carlsbad, CA' : 'CGL Laboratory, Mumbai, India',
      insuranceAmount
    ]);

    await client.query('COMMIT');

    res.json({
      submission_id: submission.id,
      grader,
      service_level,
      expected_days: GRADING_TIMES[service_level][grader],
      expected_completion: submission.expected_completion_at,
      cost: totalCost,
      insurance_value: insuranceAmount
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Submission failed' });
  } finally {
    client.release();
  }
});

// ===== GRADING RESULT ORACLE =====

router.post('/webhooks/grading-result', async (req, res) => {
  const {
    grader,
    submission_ref,
    certificate_number,
    report_url,
    results: {
      carat, color, clarity, cut, polish, symmetry, fluorescence,
      measurements, proportions, origin, comments
    }
  } = req.body;

  // Verify signature in production
  // const signature = req.headers['x-grader-signature'];
  // if (!verifySignature(grader, req.body, signature)) return res.status(401).json({ error: 'Invalid signature' });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [submission] } = await client.query(`
      SELECT * FROM grading_submissions WHERE id = $1 AND grader = $2
    `, [submission_ref, grader]);

    if (!submission) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (submission.status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Result already recorded' });
    }

    const { rows: [diamond] } = await pool.query(`
      SELECT d.*, i.ipo_price, i.total_pcus, i.id as ipo_id
      FROM diamonds d
      JOIN ipos i ON d.id = i.diamond_id
      WHERE d.id = $1
    `, [submission.diamond_id]);

    await client.query(`
      UPDATE grading_submissions
      SET status = 'completed',
          certificate_number = $2,
          report_url = $3,
          final_carat = $4,
          final_color = $5,
          final_clarity = $6,
          final_cut = $7,
          final_polish = $8,
          final_symmetry = $9,
          final_fluorescence = $10,
          measurements = $11,
          proportions = $12,
          origin = $13,
          comments = $14,
          completed_at = NOW()
      WHERE id = $1
    `, [
      submission_ref, certificate_number, report_url,
      carat, color, clarity, cut, polish, symmetry, fluorescence,
      JSON.stringify(measurements), JSON.stringify(proportions), origin, comments
    ]);

    await client.query(`
      UPDATE diamonds
      SET status = 'graded',
          final_carat = $2, final_color = $3, final_clarity = $4, final_cut = $5,
          final_polish = $6, final_symmetry = $7, final_fluorescence = $8,
          final_certificate_url = $9, grader = $10, graded_at = NOW()
      WHERE id = $1
    `, [
      submission.diamond_id, carat, color, clarity, cut,
      polish, symmetry, fluorescence, report_url, grader
    ]);

    // Calculate multiplier
    const colorMult = GRADE_MULTIPLIERS.color[diamond.estimated_color || 'unknown']?.[color] || 1.0;
    const clarityMult = GRADE_MULTIPLIERS.clarity[diamond.estimated_clarity || 'unknown']?.[clarity] || 1.0;
    const cutMult = GRADE_MULTIPLIERS.cut[diamond.estimated_cut || 'unknown']?.[cut] || 1.0;
    const caratRatio = carat / diamond.estimated_carat;
    const caratMult = Math.pow(caratRatio, 1.5);

    const totalMultiplier = colorMult * clarityMult * cutMult * caratMult;
    const baseValue = diamond.total_pcus * diamond.ipo_price;
    const gradedValue = baseValue * totalMultiplier;

    await client.query(`
      INSERT INTO graded_valuations (
        diamond_id, submission_id, base_value, graded_value, total_multiplier,
        color_mult, clarity_mult, cut_mult, carat_mult, calculated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `, [
      submission.diamond_id, submission_ref, baseValue, gradedValue,
      totalMultiplier, colorMult, clarityMult, cutMult, caratMult
    ]);

    // Update jeweler score
    const gradeAccuracy = calculateAccuracy(diamond.estimated_color, color) +
                         calculateAccuracy(diamond.estimated_clarity, clarity) +
                         calculateAccuracy(diamond.estimated_cut, cut);
    
    await client.query(`
      UPDATE jewelers
      SET quality_king_score = LEAST(1000, quality_king_score + $2),
          successful_sales = successful_sales + 1,
          total_volume = total_volume + $3,
          updated_at = NOW()
      WHERE id = $1
    `, [diamond.jeweler_id, Math.floor(gradeAccuracy * 10), gradedValue]);

    await client.query(`
      INSERT INTO post_grade_events (diamond_id, event_type, status, scheduled_at, created_at)
      VALUES ($1, 'reveal_scheduled', 'pending', NOW() + INTERVAL '24 hours', NOW())
    `, [submission.diamond_id]);

    await client.query('COMMIT');

    // Log metrics
    await pool.query(`
      INSERT INTO grading_metrics (date, grader, service_level, submitted, completed, time_days, multiplier)
      VALUES (DATE(NOW()), $1, $2, 1, 1, $3, $4)
      ON CONFLICT (date, grader, service_level) 
      DO UPDATE SET 
        completed = grading_metrics.completed + 1,
        time_days = (grading_metrics.time_days * grading_metrics.completed + $3) / (grading_metrics.completed + 1),
        multiplier = (grading_metrics.multiplier * grading_metrics.completed + $4) / (grading_metrics.completed + 1)
    `, [grader, submission.service_level, 
        (new Date() - new Date(submission.submitted_at)) / 86400000, 
        totalMultiplier]);

    res.json({
      received: true,
      diamond_id: submission.diamond_id,
      total_multiplier: totalMultiplier,
      graded_value
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Result processing failed' });
  } finally {
    client.release();
  }
});

function calculateAccuracy(estimated, actual) {
  if (!estimated || estimated === 'unknown') return 0.5;
  if (estimated === actual) return 1.0;
  
  const scales = {
    color: ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'],
    clarity: ['FL', 'IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2', 'I1', 'I2', 'I3'],
    cut: ['Ideal', 'Excellent', 'Very Good', 'Good', 'Fair', 'Poor']
  };
  
  let scale = scales.color;
  if (scales.clarity.includes(estimated)) scale = scales.clarity;
  else if (scales.cut.includes(estimated)) scale = scales.cut;
  
  const estIdx = scale.indexOf(estimated);
  const actIdx = scale.indexOf(actual);
  if (estIdx === -1 || actIdx === -1) return 0.5;
  
  return Math.max(0, 1 - (Math.abs(estIdx - actIdx) * 0.2));
}

// ===== GRADE REVEAL =====

router.get('/diamonds/:diamondId/grade', async (req, res) => {
  const { diamondId } = req.params;

  const { rows: [result] } = await pool.query(`
    SELECT 
      d.final_carat, d.final_color, d.final_clarity, d.final_cut,
      d.final_polish, d.final_symmetry, d.final_fluorescence,
      d.final_certificate_url, d.grader, d.graded_at,
      d.estimated_carat, d.estimated_color, d.estimated_clarity, d.estimated_cut,
      gv.total_multiplier, gv.base_value, gv.graded_value,
      gs.certificate_number, gs.report_url, gs.origin as final_origin,
      gs.completed_at as graded_at,
      j.quality_king_score as jeweler_score
    FROM diamonds d
    LEFT JOIN graded_valuations gv ON d.id = gv.diamond_id
    LEFT JOIN grading_submissions gs ON d.grading_submission_id = gs.id
    JOIN jewelers j ON d.jeweler_id = j.id
    WHERE d.id = $1 AND d.status IN ('graded', 'resolved', 'fully_redeemed')
  `, [diamondId]);

  if (!result) return res.status(404).json({ error: 'Grade not available' });

  res.json({
    certificate: {
      number: result.certificate_number,
      url: result.final_certificate_url,
      grader: result.grader,
      date: result.graded_at
    },
    final_grades: {
      carat: result.final_carat,
      color: result.final_color,
      clarity: result.final_clarity,
      cut: result.final_cut,
      polish: result.final_polish,
      symmetry: result.final_symmetry,
      fluorescence: result.final_fluorescence,
      origin: result.final_origin
    },
    estimates: {
      carat: result.estimated_carat,
      color: result.estimated_color,
      clarity: result.estimated_clarity,
      cut: result.estimated_cut
    },
    valuation: {
      base_value: result.base_value,
      graded_value: result.graded_value,
      total_multiplier: result.total_multiplier
    },
    jeweler_reliability: result.jeweler_score > 800 ? 'high' : result.jeweler_score > 500 ? 'medium' : 'developing'
  });
});

// Manual reveal trigger
router.post('/diamonds/:diamondId/reveal', async (req, res) => {
  const { diamondId } = req.params;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [diamond] } = await client.query(`
      SELECT * FROM diamonds WHERE id = $1 AND status = 'graded'
    `, [diamondId]);

    if (!diamond) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not ready for reveal' });
    }

    await client.query(`UPDATE diamonds SET status = 'resolved', resolved_at = NOW() WHERE id = $1`, [diamondId]);
    await client.query(`UPDATE orders SET status = 'expired' WHERE diamond_id = $1 AND status IN ('open', 'partial')`, [diamondId]);
    await client.query(`INSERT INTO post_grade_markets (diamond_id, status, opened_at) VALUES ($1, 'active', NOW())`, [diamondId]);

    await client.query('COMMIT');

    res.json({ diamond_id: diamondId, status: 'resolved', message: 'Grade revealed. Post-grade trading open.' });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Reveal failed' });
  } finally {
    client.release();
  }
});

// ===== INSURANCE CLAIMS (v1.1) =====

router.post('/grading/:submissionId/claim', requireJeweler, [
  body('claim_type').isIn(['lost_shipment', 'damage', 'theft', 'grading_error']),
  body('description').isLength({ min: 20 }),
  body('evidence_urls').isArray()
], async (req, res) => {
  const { submissionId } = req.params;
  const { claim_type, description, evidence_urls } = req.body;

  const client = await pool.connect();

  try {
    const { rows: [submission] } = await client.query(`
      SELECT gs.*, d.jeweler_id, gs.insurance_value
      FROM grading_submissions gs
      JOIN diamonds d ON gs.diamond_id = d.id
      WHERE gs.id = $1
    `, [submissionId]);

    if (!submission || submission.jeweler_id !== req.jeweler.id) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const { rows: [claim] } = await client.query(`
      INSERT INTO grading_insurance_claims (
        submission_id, diamond_id, jeweler_id, claim_type, description, 
        evidence_urls, claimed_amount, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
      RETURNING *
    `, [
      submissionId, submission.diamond_id, req.jeweler.id,
      claim_type, description, JSON.stringify(evidence_urls),
      submission.insurance_value || 0
    ]);

    res.status(201).json({
      claim_id: claim.id,
      status: 'pending',
      claimed_amount: submission.insurance_value,
      message: 'Claim submitted. Review within 5 business days.'
    });

  } catch (err) {
    res.status(500).json({ error: 'Claim submission failed' });
  } finally {
    client.release();
  }
});

// ===== MULTIPLE GRADER COMPARISON (v1.1) =====

router.get('/diamonds/:diamondId/grader-comparison', async (req, res) => {
  const { diamondId } = req.params;

  const { rows } = await pool.query(`
    SELECT 
      gs.grader,
      gs.final_color,
      gs.final_clarity,
      gs.final_cut,
      gs.final_carat,
      gv.total_multiplier,
      gs.completed_at,
      gs.certificate_number
    FROM grading_submissions gs
    LEFT JOIN graded_valuations gv ON gs.id = gv.submission_id
    WHERE gs.diamond_id = $1 AND gs.status = 'completed'
    ORDER BY gs.completed_at
  `, [diamondId]);

  if (rows.length < 2) {
    return res.json({ 
      message: 'Single grader result',
      results: rows
    });
  }

  // Calculate agreement
  const agreement = {
    color: rows.every(r => r.final_color === rows[0].final_color),
    clarity: rows.every(r => r.final_clarity === rows[0].final_clarity),
    cut: rows.every(r => r.final_cut === rows[0].final_cut),
    carat: Math.max(...rows.map(r => r.final_carat)) - Math.min(...rows.map(r => r.final_carat)) < 0.01
  };

  const multiplierDiff = Math.max(...rows.map(r => parseFloat(r.total_multiplier))) - 
                        Math.min(...rows.map(r => parseFloat(r.total_multiplier)));

  res.json({
    results: rows,
    agreement,
    multiplier_variance: multiplierDiff.toFixed(2),
    recommendation: multiplierDiff > 0.5 
      ? 'Significant variance - consider third opinion'
      : 'Results consistent'
  });
});

// ===== ADMIN/STATUS =====

router.get('/admin/grading-queue', async (req, res) => {
  const { status = 'all', grader, overdue_only = false } = req.query;

  let where = 'WHERE 1=1';
  const params = [];

  if (status !== 'all') {
    where += ` AND gs.status = $${params.length + 1}`;
    params.push(status);
  }
  if (grader) {
    where += ` AND gs.grader = $${params.length + 1}`;
    params.push(grader);
  }
  if (overdue_only === 'true') {
    where += ` AND gs.expected_completion_at < NOW() AND gs.status = 'submitted'`;
  }

  const { rows } = await pool.query(`
    SELECT 
      gs.*,
      d.estimated_carat, d.shape, d.jeweler_id,
      j.business_name,
      EXTRACT(EPOCH FROM (NOW() - gs.submitted_at))/86400 as days_in_queue,
      gs.expected_completion_at,
      CASE 
        WHEN gs.expected_completion_at < NOW() THEN 'overdue'
        WHEN gs.expected_completion_at < NOW() + INTERVAL '3 days' THEN 'at_risk'
        ELSE 'on_track'
      END as timeline_status
    FROM grading_submissions gs
    JOIN diamonds d ON gs.diamond_id = d.id
    JOIN jewelers j ON d.jeweler_id = j.id
    ${where}
    ORDER BY gs.submitted_at
  `, params);

  res.json({ 
    queue: rows,
    summary: {
      total: rows.length,
      overdue: rows.filter(r => r.timeline_status === 'overdue').length,
      at_risk: rows.filter(r => r.timeline_status === 'at_risk').length,
      avg_days: rows.reduce((a, b) => a + parseFloat(b.days_in_queue), 0) / rows.length
    }
  });
});

// Grading metrics dashboard
router.get('/admin/grading-metrics', async (req, res) => {
  const { days = 30 } = req.query;

  const { rows } = await pool.query(`
    SELECT 
      DATE_TRUNC('day', date) as day,
      grader,
      service_level,
      SUM(submitted) as submitted,
      SUM(completed) as completed,
      AVG(time_days) as avg_time_days,
      AVG(multiplier) as avg_multiplier
    FROM grading_metrics
    WHERE date > NOW() - INTERVAL '${days} days'
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC
  `);

  res.json({ metrics: rows });
});

export default router;
