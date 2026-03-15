// brick-07-quality-king-complete.js
// PCAux Diamond Platform - Complete Brick #7: Quality King Board
// Features: Core Quality King + Predictive Scoring + Gamification + Matchmaking + Tournaments

import express from 'express';
import { Pool } from 'pg';
import { requireAuth, requireJeweler, requireInvestor } from './brick-01-auth.js';

const router = express.Router();
const pool = new Pool();

// ============================================
// CONFIGURATION
// ============================================

const TIERS = {
  bronze: { min: 0, max: 199, cap_bonus: 0, fee_discount: 0 },
  silver: { min: 200, max: 499, cap_bonus: 2, fee_discount: 5 },
  gold: { min: 500, max: 999, cap_bonus: 5, fee_discount: 10 },
  platinum: { min: 1000, max: 1999, cap_bonus: 10, fee_discount: 15 },
  diamond: { min: 2000, max: Infinity, cap_bonus: 15, fee_discount: 20 }
};

const TIER_COLORS = {
  bronze: '#CD7F32',
  silver: '#C0C0C0',
  gold: '#FFD700',
  platinum: '#E5E4E2',
  diamond: '#B9F2FF'
};

const BADGE_DEFINITIONS = {
  first_home_run: {
    id: 'first_home_run',
    name: 'First Blood',
    emoji: '🎯',
    tier: 'bronze',
    points: 100,
    condition: (stats) => stats.home_runs >= 1,
    description: 'Grade your first 2x+ multiplier stone'
  },
  volume_rookie: {
    id: 'volume_rookie',
    name: 'Getting Started',
    emoji: '🌱',
    tier: 'bronze',
    points: 50,
    condition: (stats) => stats.graded_count >= 10,
    description: 'Grade 10 stones'
  },
  accuracy_king: {
    id: 'accuracy_king',
    name: 'Accuracy King',
    emoji: '👑',
    tier: 'silver',
    points: 500,
    condition: (stats) => stats.avg_accuracy >= 0.9 && stats.graded_count >= 20,
    description: 'Maintain 90%+ accuracy over 20+ stones'
  },
  volume_master: {
    id: 'volume_master',
    name: 'Volume Master',
    emoji: '💎',
    tier: 'gold',
    points: 1000,
    condition: (stats) => stats.graded_count >= 100,
    description: 'Grade 100 stones'
  },
  streak_master: {
    id: 'streak_master',
    name: 'Streak Master',
    emoji: '🔥',
    tier: 'gold',
    points: 750,
    condition: (stats) => stats.current_streak >= 10,
    description: '10-day consecutive grading streak'
  },
  perfectionist: {
    id: 'perfectionist',
    name: 'Perfectionist',
    emoji: '💯',
    tier: 'gold',
    points: 2000,
    condition: (stats) => stats.consecutive_perfect >= 10,
    description: '10 consecutive stones with 95%+ accuracy'
  },
  diamond_hands: {
    id: 'diamond_hands',
    name: 'Diamond Hands',
    emoji: '💎🙌',
    tier: 'platinum',
    points: 5000,
    condition: (stats) => stats.avg_accuracy >= 0.95 && stats.total_volume >= 1000000,
    description: '95%+ accuracy with $1M+ total volume'
  },
  unstoppable: {
    id: 'unstoppable',
    name: 'Unstoppable',
    emoji: '⚡',
    tier: 'platinum',
    points: 2500,
    condition: (stats) => stats.current_streak >= 30,
    description: '30-day consecutive grading streak'
  }
};

const TOURNAMENT_CATEGORIES = {
  quality_kings: {
    name: 'Quality Kings',
    metric: 'avg_accuracy',
    weight: 0.6,
    description: 'Highest grading accuracy'
  },
  speed_demons: {
    name: 'Speed Demons',
    metric: 'avg_response_time',
    weight: 0.4,
    inverse: true,
    description: 'Fastest grading response time'
  },
  volume_champions: {
    name: 'Volume Champions',
    metric: 'graded_count',
    weight: 0.5,
    description: 'Most stones graded'
  },
  roi_legends: {
    name: 'ROI Legends',
    metric: 'avg_investor_roi',
    weight: 0.7,
    description: 'Best investor returns generated'
  }
};

// ============================================
// CORE SCORING ENGINE
// ============================================

async function calculateJewelerScore(jewelerId, client) {
  const { rows: [stats] } = await client.query(`
    SELECT 
      COUNT(*) as total_listings,
      COUNT(CASE WHEN d.status IN ('graded', 'resolved', 'fully_redeemed') THEN 1 END) as graded_count,
      AVG(
        CASE 
          WHEN d.estimated_color = d.final_color THEN 1.0
          WHEN ABS((ARRAY_POSITION(ARRAY['D','E','F','G','H','I','J'], d.estimated_color) - 
                    ARRAY_POSITION(ARRAY['D','E','F','G','H','I','J'], d.final_color))) = 1 THEN 0.7
          WHEN ABS((ARRAY_POSITION(ARRAY['D','E','F','G','H','I','J'], d.estimated_color) - 
                    ARRAY_POSITION(ARRAY['D','E','F','G','H','I','J'], d.final_color))) = 2 THEN 0.4
          ELSE 0.1
        END +
        CASE 
          WHEN d.estimated_clarity = d.final_clarity THEN 1.0
          WHEN ABS((ARRAY_POSITION(ARRAY['FL','IF','VVS1','VVS2','VS1','VS2','SI1','SI2'], d.estimated_clarity) - 
                    ARRAY_POSITION(ARRAY['FL','IF','VVS1','VVS2','VS1','VS2','SI1','SI2'], d.final_clarity))) <= 1 THEN 0.7
          WHEN ABS((ARRAY_POSITION(ARRAY['FL','IF','VVS1','VVS2','VS1','VS2','SI1','SI2'], d.estimated_clarity) - 
                    ARRAY_POSITION(ARRAY['FL','IF','VVS1','VVS2','VS1','VS2','SI1','SI2'], d.final_clarity))) <= 2 THEN 0.4
          ELSE 0.1
        END
      ) as avg_accuracy,
      AVG(gv.total_multiplier) as avg_multiplier,
      SUM(CASE WHEN gv.total_multiplier >= 2.0 THEN 1 ELSE 0 END)::FLOAT / 
        NULLIF(COUNT(gv.id), 0) as home_run_rate,
      AVG(i.sold_pcus::FLOAT / NULLIF(i.total_pcus, 0)) as avg_fill_rate,
      SUM(d.listing_price) as total_volume
    FROM jewelers j
    LEFT JOIN diamonds d ON j.id = d.jeweler_id AND d.status IN ('graded', 'resolved', 'fully_redeemed')
    LEFT JOIN graded_valuations gv ON d.id = gv.diamond_id
    LEFT JOIN ipos i ON d.id = i.diamond_id
    WHERE j.id = $1
    GROUP BY j.id
  `, [jewelerId]);

  if (!stats || stats.graded_count === 0) {
    return { score: 0, tier: 'bronze', metrics: {} };
  }

  const accuracyWeight = 0.40;
  const multiplierWeight = 0.25;
  const volumeWeight = 0.20;
  const fillRateWeight = 0.15;

  const normalizedAccuracy = Math.min(stats.avg_accuracy || 0, 1) * 1000;
  const normalizedMultiplier = Math.min(Math.max((stats.avg_multiplier || 1) - 1, 0) / 2, 1) * 1000;
  const normalizedVolume = Math.min(stats.graded_count / 50, 1) * 1000;
  const normalizedFillRate = (stats.avg_fill_rate || 0) * 1000;

  const score = Math.round(
    normalizedAccuracy * accuracyWeight +
    normalizedMultiplier * multiplierWeight +
    normalizedVolume * volumeWeight +
    normalizedFillRate * fillRateWeight
  );

  let tier = 'bronze';
  for (const [tierName, threshold] of Object.entries(TIERS)) {
    if (score >= threshold.min && score <= threshold.max) {
      tier = tierName;
      break;
    }
  }

  return {
    score,
    tier,
    metrics: {
      total_listings: parseInt(stats.total_listings),
      graded_count: parseInt(stats.graded_count),
      avg_accuracy: parseFloat(stats.avg_accuracy)?.toFixed(3),
      avg_multiplier: parseFloat(stats.avg_multiplier)?.toFixed(2),
      home_run_rate: (parseFloat(stats.home_run_rate) * 100)?.toFixed(1) + '%',
      avg_fill_rate: (parseFloat(stats.avg_fill_rate) * 100)?.toFixed(1) + '%',
      total_volume: parseFloat(stats.total_volume) || 0
    }
  };
}

// ============================================
// ADMIN ROUTES
// ============================================

router.post('/admin/recalculate-scores', requireAuth, async (req, res) => {
  try {
    const { rows: jewelers } = await pool.query('SELECT id FROM jewelers WHERE status = $1', ['active']);
    const results = [];

    for (const jeweler of jewelers) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { score, tier, metrics } = await calculateJewelerScore(jeweler.id, client);
        
        await client.query(`
          UPDATE jewelers 
          SET quality_king_score = $2, quality_king_tier = $3, updated_at = NOW()
          WHERE id = $1
        `, [jeweler.id, score, tier]);

        await client.query(`
          INSERT INTO jeweler_score_history (jeweler_id, score, tier, metrics)
          VALUES ($1, $2, $3, $4)
        `, [jeweler.id, score, tier, JSON.stringify(metrics)]);

        await client.query('COMMIT');
        results.push({ jeweler_id: jeweler.id, score, tier, metrics });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    res.json({ updated: results.length, jewelers: results });
  } catch (err) {
    res.status(500).json({ error: 'Recalculation failed', details: err.message });
  }
});

// ============================================
// PUBLIC LEADERBOARD
// ============================================

router.get('/quality-kings', async (req, res) => {
  const { tier, limit = 20, offset = 0 } = req.query;

  try {
    let where = 'WHERE j.status = $1';
    const params = ['active'];

    if (tier) {
      where += ` AND j.quality_king_tier = $${params.length + 1}`;
      params.push(tier);
    }

    const { rows } = await pool.query(`
      SELECT 
        j.id,
        j.business_name,
        j.quality_king_tier as tier,
        j.quality_king_score as score,
        j.listing_count,
        j.successful_sales,
        j.total_volume,
        TIER_COLOR(j.quality_king_tier) as tier_color,
        (
          SELECT AVG(gv.total_multiplier)
          FROM diamonds d
          JOIN graded_valuations gv ON d.id = gv.diamond_id
          WHERE d.jeweler_id = j.id AND d.graded_at > NOW() - INTERVAL '90 days'
        ) as recent_avg_multiplier,
        (
          SELECT COUNT(*)
          FROM diamonds
          WHERE jeweler_id = j.id AND status IN ('listing', 'grading', 'graded', 'resolved')
        ) as active_listings,
        (
          SELECT COUNT(*)
          FROM jeweler_badges
          WHERE jeweler_id = j.id
        ) as badge_count
      FROM jewelers j
      ${where}
      ORDER BY j.quality_king_score DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    rows.forEach(j => {
      j.tier_benefits = TIERS[j.tier];
      j.tier_color = TIER_COLORS[j.tier];
    });

    res.json({ jewelers: rows, tiers: TIERS, total_count: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load leaderboard', details: err.message });
  }
});

router.get('/quality-kings/:jewelerId', async (req, res) => {
  const { jewelerId } = req.params;

  try {
    const { rows: [jeweler] } = await pool.query(`
      SELECT 
        j.*,
        AVG(gv.total_multiplier) as lifetime_avg_multiplier,
        COUNT(DISTINCT d.id) as total_diamonds,
        COUNT(CASE WHEN gv.total_multiplier >= 2.0 THEN 1 END) as home_runs,
        MAX(d.graded_at) as last_graded_at
      FROM jewelers j
      LEFT JOIN diamonds d ON j.id = d.jeweler_id AND d.status IN ('graded', 'resolved', 'fully_redeemed')
      LEFT JOIN graded_valuations gv ON d.id = gv.diamond_id
      WHERE j.id = $1
      GROUP BY j.id
    `, [jewelerId]);

    if (!jeweler) return res.status(404).json({ error: 'Jeweler not found' });

    const { rows: recentDiamonds } = await pool.query(`
      SELECT 
        d.id, d.estimated_carat, d.estimated_color, d.estimated_clarity,
        d.final_color, d.final_clarity, d.graded_at,
        gv.total_multiplier, i.ipo_price, i.sold_pcus
      FROM diamonds d
      JOIN graded_valuations gv ON d.id = gv.diamond_id
      JOIN ipos i ON d.id = i.diamond_id
      WHERE d.jeweler_id = $1 AND d.status IN ('graded', 'resolved', 'fully_redeemed')
      ORDER BY d.graded_at DESC LIMIT 10
    `, [jewelerId]);

    const { rows: accuracyHistory } = await pool.query(`
      SELECT 
        DATE_TRUNC('month', d.graded_at) as month,
        AVG(CASE WHEN d.estimated_color = d.final_color THEN 1 ELSE 0 END +
            CASE WHEN d.estimated_clarity = d.final_clarity THEN 1 ELSE 0 END) / 2 as color_clarity_accuracy,
        AVG(gv.total_multiplier) as avg_multiplier,
        COUNT(*) as stones_graded
      FROM diamonds d
      JOIN graded_valuations gv ON d.id = gv.diamond_id
      WHERE d.jeweler_id = $1 AND d.graded_at > NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', d.graded_at)
      ORDER BY month DESC
    `, [jewelerId]);

    const { rows: badges } = await pool.query(`
      SELECT badge_id, badge_name, badge_emoji, tier, points, earned_at
      FROM jeweler_badges
      WHERE jeweler_id = $1
      ORDER BY earned_at DESC
    `, [jewelerId]);

    jeweler.tier_benefits = TIERS[jeweler.quality_king_tier];
    jeweler.tier_color = TIER_COLORS[jeweler.quality_king_tier];
    jeweler.recent_diamonds = recentDiamonds;
    jeweler.accuracy_history = accuracyHistory;
    jeweler.badges = badges;
    jeweler.badge_points = badges.reduce((sum, b) => sum + b.points, 0);

    res.json(jeweler);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load jeweler profile', details: err.message });
  }
});

// ============================================
// JEWELER SELF-SERVICE
// ============================================

router.get('/jeweler/my-quality-king', requireJeweler, async (req, res) => {
  try {
    const client = await pool.connect();
    const { score, tier, metrics } = await calculateJewelerScore(req.jeweler.id, client);
    client.release();

    if (tier !== req.jeweler.quality_king_tier || score !== req.jeweler.quality_king_score) {
      await pool.query(`
        UPDATE jewelers 
        SET quality_king_score = $2, quality_king_tier = $3, updated_at = NOW()
        WHERE id = $1
      `, [req.jeweler.id, score, tier]);
    }

    const nextTier = tier === 'bronze' ? 'silver' : tier === 'silver' ? 'gold' : 
                     tier === 'gold' ? 'platinum' : tier === 'platinum' ? 'diamond' : null;

    res.json({
      jeweler_id: req.jeweler.id,
      business_name: req.jeweler.business_name,
      current_tier: tier,
      current_score: score,
      next_tier: nextTier,
      points_to_next: nextTier ? TIERS[nextTier].min - score : 0,
      tier_benefits: TIERS[tier],
      all_tiers: TIERS,
      metrics,
      recommendations: generateRecommendations(metrics)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate score', details: err.message });
  }
});

function generateRecommendations(metrics) {
  const recs = [];
  if (parseFloat(metrics.avg_accuracy) < 0.7) {
    recs.push('Improve estimation accuracy: Consider GIA training or better loupe equipment');
  }
  if (parseFloat(metrics.avg_fill_rate) < 0.8) {
    recs.push('Improve IPO fill rates: Price more aggressively or improve image quality');
  }
  if (parseInt(metrics.total_listings) < 10) {
    recs.push('List more stones: Volume increases score faster than perfection');
  }
  if (parseFloat(metrics.home_run_rate) < 0.1) {
    recs.push('Seek higher variance stones: Look for vintage or unusual cuts with grading upside');
  }
  return recs;
}

// ============================================
// TIER-BASED ACCESS CONTROL
// ============================================

router.get('/jeweler/:jewelerId/cap-bonus', async (req, res) => {
  try {
    const { rows: [jeweler] } = await pool.query(`
      SELECT quality_king_tier FROM jewelers WHERE id = $1
    `, [req.params.jewelerId]);

    if (!jeweler) return res.status(404).json({ error: 'Jeweler not found' });

    const bonus = TIERS[jeweler.quality_king_tier]?.cap_bonus || 0;

    res.json({
      jeweler_id: req.params.jewelerId,
      tier: jeweler.quality_king_tier,
      ipo_cap_bonus_percent: bonus,
      total_wallet_cap: 10 + bonus
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cap bonus', details: err.message });
  }
});

router.get('/jeweler/:jewelerId/fee-schedule', async (req, res) => {
  try {
    const { rows: [jeweler] } = await pool.query(`
      SELECT quality_king_tier FROM jewelers WHERE id = $1
    `, [req.params.jewelerId]);

    if (!jeweler) return res.status(404).json({ error: 'Jeweler not found' });

    const discount = TIERS[jeweler.quality_king_tier]?.fee_discount || 0;
    const basePlatformFee = 500;

    res.json({
      jeweler_id: req.params.jewelerId,
      tier: jeweler.quality_king_tier,
      base_platform_fee_bps: basePlatformFee,
      discount_bps: discount,
      effective_fee_bps: basePlatformFee - discount,
      example_5000_stone: {
        gross: 5000,
        platform_fee: 5000 * (basePlatformFee - discount) / 10000,
        jeweler_receives: 5000 - (5000 * (basePlatformFee - discount) / 10000)
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load fee schedule', details: err.message });
  }
});

// ============================================
// PREDICTIVE SCORING (Feature 1)
// ============================================

router.get('/jeweler/:jewelerId/predict-score', async (req, res) => {
  try {
    const { rows: history } = await pool.query(`
      SELECT score, calculated_at, metrics
      FROM jeweler_score_history
      WHERE jeweler_id = $1
      ORDER BY calculated_at ASC
    `, [req.params.jewelerId]);

    if (history.length < 7) {
      return res.status(400).json({
        error: 'Insufficient history',
        min_days_required: 7,
        current_days: history.length,
        current_score: history[history.length - 1]?.score || 0
      });
    }

    const predictions = calculateTrendPredictions(history);
    const confidence = calculateConfidence(history);
    const milestones = identifyMilestones(history[history.length - 1].score, predictions);

    res.json({
      jeweler_id: req.params.jewelerId,
      current_score: history[history.length - 1].score,
      current_tier: getTierFromScore(history[history.length - 1].score),
      predictions: {
        '30_days': {
          score: Math.round(predictions[30]),
          projected_tier: getTierFromScore(predictions[30]),
          confidence: confidence[30]
        },
        '60_days': {
          score: Math.round(predictions[60]),
          projected_tier: getTierFromScore(predictions[60]),
          confidence: confidence[60]
        },
        '90_days': {
          score: Math.round(predictions[90]),
          projected_tier: getTierFromScore(predictions[90]),
          confidence: confidence[90]
        }
      },
      milestones,
      trend_direction: predictions[30] > history[history.length - 1].score ? 'up' :
                      predictions[30] < history[history.length - 1].score ? 'down' : 'stable',
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Prediction failed', details: err.message });
  }
});

function calculateTrendPredictions(history) {
  const recent = history.slice(-30);
  const n = recent.length;
  
  if (n < 2) {
    const lastScore = history[history.length - 1]?.score || 0;
    return { 30: lastScore, 60: lastScore, 90: lastScore };
  }

  const sumX = recent.reduce((sum, _, i) => sum + i, 0);
  const sumY = recent.reduce((sum, h) => sum + h.score, 0);
  const sumXY = recent.reduce((sum, h, i) => sum + i * h.score, 0);
  const sumXX = recent.reduce((sum, _, i) => sum + i * i, 0);
  
  const denominator = n * sumXX - sumX * sumX;
  const slope = denominator !== 0 ? (n * sumXY - sumX * sumY) / denominator : 0;
  const intercept = (sumY - slope * sumX) / n;
  
  return {
    30: Math.max(0, intercept + slope * (n + 30)),
    60: Math.max(0, intercept + slope * (n + 60)),
    90: Math.max(0, intercept + slope * (n + 90))
  };
}

function calculateConfidence(history) {
  const scores = history.map(h => h.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length;
  const volatility = Math.sqrt(variance);
  
  const baseConfidence = Math.max(0.3, 1 - (volatility / 1000));
  
  return {
    30: Math.round(baseConfidence * 100),
    60: Math.round(baseConfidence * 0.9 * 100),
    90: Math.round(baseConfidence * 0.8 * 100)
  };
}

function identifyMilestones(currentScore, predictions) {
  const milestones = [];
  const tiers = [
    { name: 'silver', threshold: 200, reward: '5% fee discount' },
    { name: 'gold', threshold: 500, reward: '10% fee discount + $5K cap bonus' },
    { name: 'platinum', threshold: 1000, reward: '15% fee discount + $10K cap bonus' },
    { name: 'diamond', threshold: 2000, reward: '20% fee discount + $15K cap bonus + featured placement' }
  ];

  tiers.forEach(tier => {
    if (currentScore < tier.threshold) {
      const daysToReach = Object.entries(predictions).find(([days, score]) => score >= tier.threshold);
      if (daysToReach) {
        milestones.push({
          tier: tier.name,
          current_score: currentScore,
          target_score: tier.threshold,
          points_needed: tier.threshold - currentScore,
          projected_date: new Date(Date.now() + parseInt(daysToReach[0]) * 24 * 60 * 60 * 1000).toISOString(),
          reward: tier.reward,
          confidence: daysToReach[1] > tier.threshold ? 'high' : 'medium'
        });
      }
    }
  });

  return milestones;
}

function getTierFromScore(score) {
  for (const [tierName, threshold] of Object.entries(TIERS)) {
    if (score >= threshold.min && score <= threshold.max) return tierName;
  }
  return 'bronze';
}

// ============================================
// GAMIFICATION BADGES (Feature 2)
// ============================================

router.post('/jeweler/:jewelerId/check-badges', async (req, res) => {
  try {
    const stats = await getBadgeStats(req.params.jewelerId);
    
    const { rows: existing } = await pool.query(`
      SELECT badge_id FROM jeweler_badges WHERE jeweler_id = $1
    `, [req.params.jewelerId]);
    const existingIds = new Set(existing.map(e => e.badge_id));
    
    const newBadges = [];

    for (const [key, badge] of Object.entries(BADGE_DEFINITIONS)) {
      if (!existingIds.has(key) && badge.condition(stats)) {
        await pool.query(`
          INSERT INTO jeweler_badges (jeweler_id, badge_id, badge_name, badge_emoji, tier, points)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [req.params.jewelerId, key, badge.name, badge.emoji, badge.tier, badge.points]);
        
        newBadges.push({
          id: key,
          name: badge.name,
          emoji: badge.emoji,
          tier: badge.tier,
          points: badge.points,
          description: badge.description
        });
      }
    }
    
    if (newBadges.length > 0) {
      await pool.query(`
        UPDATE jewelers 
        SET badge_points = COALESCE(badge_points, 0) + $2
        WHERE id = $1
      `, [req.params.jewelerId, newBadges.reduce((sum, b) => sum + b.points, 0)]);
    }
    
    res.json({
      jeweler_id: req.params.jewelerId,
      new_badges_earned: newBadges,
      total_new_points: newBadges.reduce((sum, b) => sum + b.points, 0)
    });
  } catch (err) {
    res.status(500).json({ error: 'Badge check failed', details: err.message });
  }
});

router.get('/jeweler/:jewelerId/badges', async (req, res) => {
  try {
    const { rows: badges } = await pool.query(`
      SELECT badge_id, badge_name, badge_emoji, tier, points, earned_at
      FROM jeweler_badges
      WHERE jeweler_id = $1
      ORDER BY earned_at DESC
    `, [req.params.jewelerId]);
    
    const { rows: [totals] } = await pool.query(`
      SELECT COALESCE(badge_points, 0) as total_points
      FROM jewelers
      WHERE id = $1
    `, [req.params.jewelerId]);
    
    res.json({
      jeweler_id: req.params.jewelerId,
      badges,
      summary: totals
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load badges', details: err.message });
  }
});

async function getBadgeStats(jewelerId) {
  const { rows: [stats] } = await pool.query(`
    SELECT 
      COUNT(*) as graded_count,
      AVG(CASE 
        WHEN estimated_color = final_color THEN 1.0
        ELSE 0.5
      END) as avg_accuracy,
      COUNT(CASE WHEN gv.total_multiplier >= 2.0 THEN 1 END) as home_runs,
      SUM(d.listing_price) as total_volume
    FROM diamonds d
    LEFT JOIN graded_valuations gv ON d.id = gv.diamond_id
    WHERE d.jeweler_id = $1 AND d.status IN ('graded', 'resolved', 'fully_redeemed')
  `, [jewelerId]);
  
  const { rows: streakData } = await pool.query(`
    SELECT DISTINCT DATE(graded_at) as grade_date
    FROM diamonds
    WHERE jeweler_id = $1 AND graded_at > NOW() - INTERVAL '30 days'
    ORDER BY grade_date DESC
  `, [jewelerId]);
  
  let currentStreak = 0;
  let lastDate = new Date();
  for (const row of streakData) {
    const date = new Date(row.grade_date);
    const diffDays = Math.floor((lastDate - date) / (1000 * 60 * 60 * 24));
    if (diffDays <= 1) {
      currentStreak++;
      lastDate = date;
    } else {
      break;
    }
  }
  
  return {
    graded_count: parseInt(stats.graded_count) || 0,
    avg_accuracy: parseFloat(stats.avg_accuracy) || 0,
    home_runs: parseInt(stats.home_runs) || 0,
    total_volume: parseFloat(stats.total_volume) || 0,
    current_streak: currentStreak,
    consecutive_perfect: 0 // Simplified for now
  };
}

// ============================================
// MATCHMAKING (Feature 3)
// ============================================

router.get('/investors/:investorId/recommended-jewelers', requireInvestor, async (req, res) => {
  try {
    const { rows: jewelers } = await pool.query(`
      SELECT 
        j.id,
        j.business_name,
        j.quality_king_tier,
        j.quality_king_score,
        AVG(gv.total_multiplier) as avg_multiplier,
        STDDEV(gv.total_multiplier) as multiplier_volatility,
        COUNT(CASE WHEN gv.total_multiplier >= 2.0 THEN 1 END)::FLOAT / 
          NULLIF(COUNT(gv.id), 0) as home_run_rate,
        AVG(CASE WHEN d.estimated_color = d.final_color THEN 1.0 ELSE 0.5 END) as accuracy_score
      FROM jewelers j
      LEFT JOIN diamonds d ON j.id = d.jeweler_id AND d.status IN ('graded', 'resolved')
      LEFT JOIN graded_valuations gv ON d.id = gv.diamond_id
      WHERE j.status = 'active' AND j.quality_king_score > 0
      GROUP BY j.id
      HAVING COUNT(gv.id) >= 5
    `);
    
    const matches = jewelers.map(j => {
      const riskScore = Math.max(0.1, 1 - ((j.multiplier_volatility || 0.5) * 5));
      const perfScore = Math.min((j.avg_multiplier || 1.5) / 2.5, 1);
      const qualScore = (j.accuracy_score || 0.8) * 0.8;
      const overall = (riskScore * 0.3 + perfScore * 0.4 + qualScore * 0.3);
      
      return {
        jeweler: {
          id: j.id,
          name: j.business_name,
          tier: j.quality_king_tier,
          score: j.quality_king_score
        },
        match_score: Math.round(overall * 100),
        stats: {
          avg_multiplier: parseFloat(j.avg_multiplier)?.toFixed(2),
          home_run_rate: (parseFloat(j.home_run_rate) * 100)?.toFixed(1) + '%'
        }
      };
    }).sort((a, b) => b.match_score - a.match_score).slice(0, 10);
    
    res.json({
      investor_id: req.params.investorId,
      matches,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Matchmaking failed', details: err.message });
  }
});

// ============================================
// TOURNAMENTS (Feature 4)
// ============================================

router.get('/tournaments/:category/leaderboard', async (req, res) => {
  const { category } = req.params;
  const now = new Date();
  const tournamentId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  try {
    const { rows: rankings } = await pool.query(`
      SELECT 
        tr.rank,
        tr.jeweler_id,
        j.business_name,
        j.quality_king_tier,
        tr.score,
        tr.prize_amount,
        tr.badge_awarded
      FROM tournament_rankings tr
      JOIN jewelers j ON tr.jeweler_id = j.id
      WHERE tr.tournament_id = $1 AND tr.category = $2
      ORDER BY tr.rank ASC
      LIMIT 50
    `, [tournamentId, category]);
    
    res.json({
      tournament: {
        id: tournamentId,
        category: TOURNAMENT_CATEGORIES[category],
        days_remaining: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate()
      },
      leaderboard: rankings
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tournament', details: err.message });
  }
});

router.post('/admin/tournaments/calculate', requireAuth, async (req, res) => {
  const { year, month, category } = req.body;
  const tournamentId = `${year}-${String(month).padStart(2, '0')}`;
  const config = TOURNAMENT_CATEGORIES[category];
  
  try {
    let metricQuery = config.metric === 'avg_accuracy' ? 
      "AVG(CASE WHEN d.estimated_color = d.final_color THEN 1.0 ELSE 0.0 END)" :
      config.metric === 'graded_count' ? "COUNT(d.id)::decimal" :
      "AVG(gv.total_multiplier)";
    
    const { rows: scores } = await pool.query(`
      SELECT 
        j.id as jeweler_id,
        ${metricQuery} as metric_value,
        COUNT(d.id) as graded_count
      FROM jewelers j
      LEFT JOIN diamonds d ON j.id = d.jeweler_id 
        AND d.status IN ('graded', 'resolved')
        AND EXTRACT(MONTH FROM d.graded_at) = $1
        AND EXTRACT(YEAR FROM d.graded_at) = $2
      LEFT JOIN graded_valuations gv ON d.id = gv.diamond_id
      WHERE j.status = 'active'
      GROUP BY j.id
      HAVING COUNT(d.id) >= 5
    `, [month, year]);
    
    const ranked = scores.map(s => ({
      jeweler_id: s.jeweler_id,
      score: config.inverse ? 
        (1 / ((parseFloat(s.metric_value) || 1) + 1)) * config.weight : 
        (parseFloat(s.metric_value) || 0) * config.weight,
      metric_value: parseFloat(s.metric_value) || 0,
      graded_count: parseInt(s.graded_count)
    })).sort((a, b) => b.score - a.score);
    
    for (let i = 0; i < ranked.length; i++) {
      const rank = i + 1;
      const prize = rank === 1 ? 4000 : rank === 2 ? 2500 : rank === 3 ? 1500 : 
                    rank <= 10 ? 150 : rank <= 50 ? 25 : 0;
      const badge = rank === 1 ? 'tournament_champion' : rank <= 10 ? 'tournament_elite' : null;
      
      await pool.query(`
        INSERT INTO tournament_rankings 
          (tournament_id, jeweler_id, category, rank, score, metric_value, graded_count, prize_amount, badge_awarded)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (tournament_id, jeweler_id, category) 
        DO UPDATE SET rank = $4, score = $5, metric_value = $6, graded_count = $7, prize_amount = $8, badge_awarded = $9
      `, [tournamentId, ranked[i].jeweler_id, category, rank, ranked[i].score, 
          ranked[i].metric_value, ranked[i].graded_count, prize, badge]);
    }
    
    res.json({ calculated: ranked.length, tournament_id: tournamentId, top_3: ranked.slice(0, 3) });
  } catch (err) {
    res.status(500).json({ error: 'Tournament calculation failed', details: err.message });
  }
});

// ============================================
// WEBHOOKS & CRON
// ============================================

router.post('/webhooks/grading-completed', async (req, res) => {
  try {
    const { jeweler_id } = req.body;
    await pool.query('SELECT update_jeweler_score($1)', [jeweler_id]);
    res.json({ processed: true });
  } catch (err) {
    res.status(500).json({ error: 'Webhook processing failed', details: err.message });
  }
});

router.post('/cron/daily-update', async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const { rows: jewelers } = await pool.query("SELECT id FROM jewelers WHERE status = 'active'");
    for (const j of jewelers) {
      await pool.query('SELECT update_jeweler_score($1)', [j.id]);
    }
    res.json({ processed: jewelers.length });
  } catch (err) {
    res.status(500).json({ error: 'Daily update failed', details: err.message });
  }
});

export default router;
