// archive/bricks/brick-07-quality-king.js
// PCAux Diamond Platform - Brick #7: Quality King Board (Vercel/Supabase)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

// ===== CORE SCORING =====

async function calculateJewelerScore(jewelerId) {
  const { data: stats } = await supabase
    .from('diamonds')
    .select(`
      *,
      graded_valuations!inner(total_multiplier),
      ipos!inner(sold_pcus, total_pcus)
    `)
    .eq('jeweler_id', jewelerId)
    .in('status', ['graded', 'resolved', 'fully_redeemed']);

  if (!stats || stats.length === 0) {
    return { score: 0, tier: 'bronze', metrics: {} };
  }

  const totalListings = stats.length;
  const gradedCount = stats.filter(s => s.graded_valuations).length;
  
  const accuracies = stats.map(s => {
    const colorAcc = s.estimated_color === s.final_color ? 1.0 : 
      Math.abs(['D','E','F','G','H','I','J'].indexOf(s.estimated_color) - 
                ['D','E','F','G','H','I','J'].indexOf(s.final_color)) <= 1 ? 0.7 : 0.4;
    const clarityAcc = s.estimated_clarity === s.final_clarity ? 1.0 : 0.5;
    return (colorAcc + clarityAcc) / 2;
  });

  const avgAccuracy = accuracies.reduce((a, b) => a + b, 0) / accuracies.length;
  const multipliers = stats.map(s => s.graded_valuations?.total_multiplier || 1).filter(m => m);
  const avgMultiplier = multipliers.reduce((a, b) => a + b, 0) / multipliers.length;
  
  const fillRates = stats.map(s => s.ipos?.sold_pcus / s.ipos?.total_pcus).filter(f => f);
  const avgFillRate = fillRates.reduce((a, b) => a + b, 0) / fillRates.length;

  const normalizedAccuracy = Math.min(avgAccuracy, 1) * 1000;
  const normalizedMultiplier = Math.min(Math.max(avgMultiplier - 1, 0) / 2, 1) * 1000;
  const normalizedVolume = Math.min(gradedCount / 50, 1) * 1000;
  const normalizedFillRate = avgFillRate * 1000;

  const score = Math.round(
    normalizedAccuracy * 0.40 +
    normalizedMultiplier * 0.25 +
    normalizedVolume * 0.20 +
    normalizedFillRate * 0.15
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
      total_listings: totalListings,
      graded_count: gradedCount,
      avg_accuracy: avgAccuracy?.toFixed(3),
      avg_multiplier: avgMultiplier?.toFixed(2),
      avg_fill_rate: (avgFillRate * 100)?.toFixed(1) + '%'
    }
  };
}

// ===== ADMIN =====

export async function recalculateScores(req, res) {
  try {
    const { data: jewelers } = await supabase
      .from('jewelers')
      .select('id')
      .eq('status', 'active');

    const results = [];

    for (const jeweler of jewelers) {
      const { score, tier, metrics } = await calculateJewelerScore(jeweler.id);
      
      await supabase
        .from('jewelers')
        .update({ quality_king_score: score, quality_king_tier: tier, updated_at: new Date().toISOString() })
        .eq('id', jeweler.id);

      await supabase.from('jeweler_score_history').insert({
        jeweler_id: jeweler.id,
        score,
        tier,
        metrics,
        calculated_at: new Date().toISOString()
      });

      results.push({ jeweler_id: jeweler.id, score, tier, metrics });
    }

    return res.json({ updated: results.length, jewelers: results });
  } catch (err) {
    return res.status(500).json({ error: 'Recalculation failed' });
  }
}

// ===== PUBLIC LEADERBOARD =====

export async function getQualityKings(req, res) {
  const { tier, limit = 20, offset = 0 } = req.query;

  try {
    let query = supabase
      .from('jewelers')
      .select(`
        id,
        business_name,
        quality_king_tier,
        quality_king_score,
        listing_count,
        successful_sales,
        total_volume
      `)
      .eq('status', 'active')
      .order('quality_king_score', { ascending: false })
      .range(offset, offset + limit - 1);

    if (tier) query = query.eq('quality_king_tier', tier);

    const { data: jewelers } = await query;

    const enriched = jewelers?.map(j => ({
      ...j,
      tier_color: TIER_COLORS[j.quality_king_tier],
      tier_benefits: TIERS[j.quality_king_tier]
    }));

    return res.json({ jewelers: enriched, tiers: TIERS });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load leaderboard' });
  }
}

export async function getJewelerProfile(req, res) {
  const { jewelerId } = req.params;

  try {
    const { data: jeweler } = await supabase
      .from('jewelers')
      .select(`
        *,
        diamonds!left(
          estimated_carat, final_carat, estimated_color, final_color,
          estimated_clarity, final_clarity, graded_at,
          graded_valuations!inner(total_multiplier),
          ipos!inner(ipo_price, sold_pcus)
        )
      `)
      .eq('id', jewelerId)
      .single();

    if (!jeweler) return res.status(404).json({ error: 'Jeweler not found' });

    const recentDiamonds = jeweler.diamonds?.slice(0, 10) || [];
    
    const { data: badges } = await supabase
      .from('jeweler_badges')
      .select('*')
      .eq('jeweler_id', jewelerId)
      .order('earned_at', { ascending: false });

    return res.json({
      ...jeweler,
      tier_color: TIER_COLORS[jeweler.quality_king_tier],
      tier_benefits: TIERS[jeweler.quality_king_tier],
      recent_diamonds: recentDiamonds,
      badges: badges || [],
      badge_points: badges?.reduce((sum, b) => sum + (b.points || 0), 0) || 0
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to load profile' });
  }
}

// ===== JEWELER SELF-SERVICE =====

export async function getMyQualityKing(req, res) {
  try {
    const { score, tier, metrics } = await calculateJewelerScore(req.jeweler.id);

    if (tier !== req.jeweler.quality_king_tier || score !== req.jeweler.quality_king_score) {
      await supabase
        .from('jewelers')
        .update({ quality_king_score: score, quality_king_tier: tier, updated_at: new Date().toISOString() })
        .eq('id', req.jeweler.id);
    }

    const nextTier = tier === 'bronze' ? 'silver' : tier === 'silver' ? 'gold' : 
                     tier === 'gold' ? 'platinum' : tier === 'platinum' ? 'diamond' : null;

    return res.json({
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
    return res.status(500).json({ error: 'Failed to calculate score' });
  }
}

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
  return recs;
}

// ===== TIER BENEFITS =====

export async function getCapBonus(req, res) {
  const { jewelerId } = req.params;

  try {
    const { data: jeweler } = await supabase
      .from('jewelers')
      .select('quality_king_tier')
      .eq('id', jewelerId)
      .single();

    if (!jeweler) return res.status(404).json({ error: 'Jeweler not found' });

    const bonus = TIERS[jeweler.quality_king_tier]?.cap_bonus || 0;

    return res.json({
      jeweler_id: jewelerId,
      tier: jeweler.quality_king_tier,
      ipo_cap_bonus_percent: bonus,
      total_wallet_cap: 10 + bonus
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load cap bonus' });
  }
}

export async function getFeeSchedule(req, res) {
  const { jewelerId } = req.params;

  try {
    const { data: jeweler } = await supabase
      .from('jewelers')
      .select('quality_king_tier')
      .eq('id', jewelerId)
      .single();

    if (!jeweler) return res.status(404).json({ error: 'Jeweler not found' });

    const discount = TIERS[jeweler.quality_king_tier]?.fee_discount || 0;
    const basePlatformFee = 500;

    return res.json({
      jeweler_id: jewelerId,
      tier: jeweler.quality_king_tier,
      base_platform_fee_bps: basePlatformFee,
      discount_bps: discount,
      effective_fee_bps: basePlatformFee - discount
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load fee schedule' });
  }
}

// ===== PREDICTIVE SCORING =====

export async function predictScore(req, res) {
  const { jewelerId } = req.params;

  try {
    const { data: history } = await supabase
      .from('jeweler_score_history')
      .select('score, calculated_at')
      .eq('jeweler_id', jewelerId)
      .order('calculated_at', { ascending: true });

    if (history.length < 7) {
      return res.status(400).json({
        error: 'Insufficient history',
        min_days_required: 7,
        current_days: history.length
      });
    }

    const recent = history.slice(-30);
    const scores = recent.map(h => h.score);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const trend = (scores[scores.length - 1] - scores[0]) / scores.length;

    const predictions = {
      30: Math.max(0, avg + trend * 30),
      60: Math.max(0, avg + trend * 60),
      90: Math.max(0, avg + trend * 90)
    };

    return res.json({
      jeweler_id: jewelerId,
      current_score: scores[scores.length - 1],
      predictions: {
        '30_days': { score: Math.round(predictions[30]) },
        '60_days': { score: Math.round(predictions[60]) },
        '90_days': { score: Math.round(predictions[90]) }
      },
      trend_direction: trend > 0 ? 'up' : trend < 0 ? 'down' : 'stable'
    });

  } catch (err) {
    return res.status(500).json({ error: 'Prediction failed' });
  }
}

// ===== MATCHMAKING =====

export async function getRecommendedJewelers(req, res) {
  const { investorId } = req.params;

  try {
    const { data: jewelers } = await supabase
      .from('jewelers')
      .select(`
        id,
        business_name,
        quality_king_tier,
        quality_king_score,
        diamonds!left(
          graded_valuations!inner(total_multiplier),
          estimated_color, final_color,
          estimated_clarity, final_clarity
        )
      `)
      .eq('status', 'active')
      .gt('quality_king_score', 0);

    const matches = jewelers?.map(j => {
      const diamonds = j.diamonds || [];
      const multipliers = diamonds.map(d => d.graded_valuations?.total_multiplier).filter(m => m);
      const avgMult = multipliers.length ? multipliers.reduce((a, b) => a + b, 0) / multipliers.length : 1.5;
      
      const accuracies = diamonds.map(d => {
        const colorAcc = d.estimated_color === d.final_color ? 1 : 0.5;
        const clarityAcc = d.estimated_clarity === d.final_clarity ? 1 : 0.5;
        return (colorAcc + clarityAcc) / 2;
      });
      const avgAcc = accuracies.length ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : 0.8;

      return {
        jeweler: {
          id: j.id,
          name: j.business_name,
          tier: j.quality_king_tier,
          score: j.quality_king_score
        },
        match_score: Math.round((avgMult / 2.5 * 0.4 + avgAcc * 0.3 + (j.quality_king_score / 2000) * 0.3) * 100),
        stats: { avg_multiplier: avgMult.toFixed(2) }
      };
    }).sort((a, b) => b.match_score - a.match_score).slice(0, 10);

    return res.json({ investor_id: investorId, matches });
  } catch (err) {
    return res.status(500).json({ error: 'Matchmaking failed' });
  }
}

// ===== TOURNAMENTS =====

export async function getTournamentLeaderboard(req, res) {
  const { category } = req.params;
  const now = new Date();
  const tournamentId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  try {
    const { data: rankings } = await supabase
      .from('tournament_rankings')
      .select(`
        rank,
        jeweler_id,
        jewelers!inner(business_name),
        score,
        prize_amount,
        badge_awarded
      `)
      .eq('tournament_id', tournamentId)
      .eq('category', category)
      .order('rank', { ascending: true })
      .limit(50);

    return res.json({
      tournament: {
        id: tournamentId,
        category,
        days_remaining: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate()
      },
      leaderboard: rankings
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load tournament' });
  }
}
