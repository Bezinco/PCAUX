// brick-12-demo-market-hardened.js
// PCaux Diamond Platform - Brick #12: Demo Market with Simulated Players
// Hardened version with constraint enforcement, cooldowns, and trade grouping

import express from 'express';
import { Pool } from 'pg';
import { requireAdmin } from './brick-01-auth.js';

const router = express.Router();
const pool = new Pool();

// ============================================
// CONFIGURATION
// ============================================

const DEMO_CONFIG = {
  enabled: process.env.DEMO_MODE === 'true',
  minPlayers: parseInt(process.env.DEMO_MIN_PLAYERS) || 3,
  maxPlayers: parseInt(process.env.DEMO_MAX_PLAYERS) || 8,
  activityIntervalMs: parseInt(process.env.DEMO_INTERVAL_MS) || 30000,
  tradeProbability: parseFloat(process.env.DEMO_TRADE_PROB) || 0.4,
  bidProbability: parseFloat(process.env.DEMO_BID_PROB) || 0.6,
  maxPriceVolatilityPct: parseFloat(process.env.DEMO_MAX_VOLATILITY) || 5
};

// ============================================
// PLAYER MANAGEMENT
// ============================================

// Initialize demo players with PCU balances
router.post('/admin/demo/init', requireAdmin, async (req, res) => {
  try {
    const { rows: players } = await pool.query(`
      SELECT player_address, player_name, personality, min_pcu, max_pcu, pcu_balance
      FROM demo_players 
      WHERE is_active = true
    `);
    
    let totalSeeded = 0;
    
    for (const player of players) {
      // Use existing pcu_balance or generate new if zero
      const startingPCU = player.pcu_balance > 0 
        ? player.pcu_balance 
        : Math.floor(player.min_pcu + Math.random() * (player.max_pcu - player.min_pcu));
      
      // Seed or update PCU balance
      await pool.query(`
        INSERT INTO pcu_balances (wallet_address, balance, general_funds, created_at)
        VALUES ($1, $2, $2, NOW())
        ON CONFLICT (wallet_address) DO UPDATE
        SET balance = GREATEST(pcu_balances.balance, EXCLUDED.balance),
            general_funds = GREATEST(pcu_balances.general_funds, EXCLUDED.general_funds),
            updated_at = NOW()
      `, [player.player_address, startingPCU]);
      
      // Update player balance tracking
      await pool.query(`
        UPDATE demo_players 
        SET pcu_balance = $1,
            last_action_at = NOW()
        WHERE player_address = $2
      `, [startingPCU, player.player_address]);
      
      // Add to demo leaderboard
      await pool.query(`
        INSERT INTO leaderboard_entries (leaderboard_key, wallet_address, carats_prorated, value_prorated, shares_received, gems_count, last_activity_at)
        VALUES ('demo', $1, $2, $3, $4, 0, NOW())
        ON CONFLICT (leaderboard_key, wallet_address) DO UPDATE
        SET carats_prorated = leaderboard_entries.carats_prorated + $2,
            value_prorated = leaderboard_entries.value_prorated + $3,
            shares_received = leaderboard_entries.shares_received + $4,
            last_activity_at = NOW()
      `, [player.player_address, startingPCU / 1000, startingPCU * 10, Math.floor(startingPCU / 100)]);
      
      totalSeeded += startingPCU;
    }
    
    // Enable demo mode
    await pool.query(`UPDATE demo_config SET value = 'true', updated_at = NOW() WHERE key = 'demo_mode_enabled'`);
    
    res.json({
      message: 'Demo market initialized with simulated players',
      players_activated: players.length,
      total_pcu_seeded: totalSeeded,
      player_roster: players.map(p => ({ name: p.player_name, personality: p.personality, starting_balance: p.pcu_balance || 'generated' }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Demo init failed', details: err.message });
  }
});

// Get all simulated players with current state
router.get('/demo/players', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        dp.player_address,
        dp.player_name,
        dp.personality,
        dp.aggression,
        dp.cooldown_seconds,
        dp.pcu_balance,
        dp.is_active,
        dp.last_action_at,
        COALESCE(pb.balance, 0) as current_pcu_balance,
        NOW() - dp.last_action_at as time_since_last_action,
        CASE 
          WHEN dp.last_action_at IS NULL THEN true
          WHEN EXTRACT(EPOCH FROM (NOW() - dp.last_action_at)) > dp.cooldown_seconds THEN true
          ELSE false
        END as can_act
      FROM demo_players dp
      LEFT JOIN pcu_balances pb ON dp.player_address = pb.wallet_address
      WHERE dp.is_active = true 
      ORDER BY dp.personality, dp.player_name
    `);
    
    res.json({
      demo_mode: DEMO_CONFIG.enabled,
      total_players: rows.length,
      players_ready: rows.filter(p => p.can_act).length,
      players: rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Player lookup failed', details: err.message });
  }
});

// ============================================
// MARKET DATA FEED
// ============================================

// Generate realistic market data for active gems
router.get('/demo/feed', async (req, res) => {
  const { gem_type, limit = 10 } = req.query;
  
  try {
    // Get real gems from database
    const { rows: gems } = await pool.query(`
      SELECT g.id, g.gem_type, g.estimated_carat, g.estimated_color, g.estimated_clarity,
             COALESCE(i.ipo_price, g.estimated_carat * 1000) as base_price
      FROM gems g
      LEFT JOIN ipos i ON g.id = i.gem_id
      WHERE g.status IN ('verified', 'listing', 'grading', 'precert', 'postcert')
      ${gem_type ? "AND g.gem_type = $1" : ""}
      ORDER BY RANDOM()
      LIMIT $${gem_type ? '2' : '1'}
    `, gem_type ? [gem_type, limit] : [limit]);
    
    // Generate realistic market data with volatility constraints
    const feed = await Promise.all(gems.map(async (gem) => {
      const maxVolatility = DEMO_CONFIG.maxPriceVolatilityPct / 100;
      const volatility = (Math.random() * maxVolatility * 2) - maxVolatility;
      const trend = (Math.random() * 0.01) - 0.005;
      const spread = 0.01 + (Math.random() * 0.02);
      
      const basePrice = parseFloat(gem.base_price);
      const bid = Math.max(0.01, basePrice * (1 + trend + volatility));
      const ask = bid * (1 + spread);
      const last = (bid + ask) / 2;
      
      // Order book depth (improvement #8)
      const bidSize = Math.floor(Math.random() * 1000) + 100;
      const askSize = Math.floor(Math.random() * 800) + 80;
      
      // Upsert market state with NOT NULL enforcement
      const { rows: [state] } = await pool.query(`
        INSERT INTO demo_market_state (
          gem_id, 
          simulated_bid, 
          simulated_ask, 
          simulated_bid_size,
          simulated_ask_size,
          last_trade_price,
          player_activity_count,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, FLOOR(RANDOM() * 5), NOW())
        ON CONFLICT (gem_id) DO UPDATE
        SET simulated_bid = GREATEST(0.01, demo_market_state.simulated_bid * (0.98 + RANDOM() * 0.04)),
            simulated_ask = GREATEST(0.01, demo_market_state.simulated_ask * (0.98 + RANDOM() * 0.04)),
            simulated_bid_size = GREATEST(0, demo_market_state.simulated_bid_size + FLOOR(RANDOM() * 100 - 50)),
            simulated_ask_size = GREATEST(0, demo_market_state.simulated_ask_size + FLOOR(RANDOM() * 80 - 40)),
            last_trade_price = GREATEST(0.01, demo_market_state.last_trade_price * (0.99 + RANDOM() * 0.02)),
            player_activity_count = demo_market_state.player_activity_count + FLOOR(RANDOM() * 3),
            updated_at = NOW()
        RETURNING *
      `, [gem.id, bid, ask, bidSize, askSize, last]);
      
      return {
        gem_id: gem.id,
        gem_type: gem.gem_type,
        carats: gem.estimated_carat,
        color: gem.estimated_color,
        clarity: gem.estimated_clarity,
        bid: parseFloat(state.simulated_bid).toFixed(2),
        bid_size: parseFloat(state.simulated_bid_size).toFixed(2),
        ask: parseFloat(state.simulated_ask).toFixed(2),
        ask_size: parseFloat(state.simulated_ask_size).toFixed(2),
        last: parseFloat(state.last_trade_price).toFixed(2),
        spread: ((parseFloat(state.simulated_ask) - parseFloat(state.simulated_bid)) / parseFloat(state.simulated_bid) * 100).toFixed(2) + '%',
        volume_24h: Math.floor(Math.random() * 5000) + 500,
        player_activity: state.player_activity_count,
        change_24h: (Math.random() * 6 - 3).toFixed(2) + '%'
      };
    }));
    
    res.json({
      market: 'demo',
      timestamp: new Date().toISOString(),
      active_symbols: feed.length,
      data: feed
    });
  } catch (err) {
    res.status(500).json({ error: 'Feed generation failed', details: err.message });
  }
});

// Server-Sent Events for real-time updates
router.get('/demo/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sendUpdate = async () => {
    try {
      // Get random recent player activity with trade grouping
      const { rows: [activity] } = await pool.query(`
        SELECT 
          da.player_name, 
          da.player_address, 
          da.action, 
          da.price, 
          da.side,
          da.quantity,
          da.trade_group,
          da.personality,
          g.gem_type,
          g.estimated_carat
        FROM demo_activity da
        JOIN gems g ON da.gem_id = g.id
        WHERE da.created_at > NOW() - INTERVAL '5 minutes'
        ORDER BY RANDOM()
        LIMIT 1
      `);
      
      if (activity) {
        const update = {
          type: 'player_action',
          player: activity.player_name,
          personality: activity.personality,
          action: activity.action,
          gem_type: activity.gem_type,
          carats: activity.estimated_carat,
          price: parseFloat(activity.price).toFixed(2),
          quantity: activity.quantity,
          side: activity.side,
          trade_group: activity.trade_group,
          timestamp: new Date().toISOString()
        };
        res.write(`data: ${JSON.stringify(update)}\n\n`);
      }
    } catch (err) {
      // Silent fail for stream
    }
  };
  
  // Send initial heartbeat
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  
  const interval = setInterval(sendUpdate, 5000);
  
  req.on('close', () => clearInterval(interval));
});

// ============================================
// PLAYER ACTIVITY GENERATOR (with cooldown enforcement)
// ============================================

// Generate one round of simulated player activity
router.post('/admin/demo/tick', requireAdmin, async (req, res) => {
  const { intensity = 1.0, focus_gem_id } = req.body;
  
  try {
    // Get players who can act (respecting cooldown - improvement #4)
    const { rows: players } = await pool.query(`
      SELECT 
        player_address,
        player_name,
        personality,
        min_pcu,
        max_pcu,
        aggression,
        cooldown_seconds,
        pcu_balance,
        last_action_at,
        NOW() - last_action_at as time_since_last_action,
        CASE 
          WHEN last_action_at IS NULL THEN true
          WHEN EXTRACT(EPOCH FROM (NOW() - last_action_at)) > cooldown_seconds THEN true
          ELSE false
        END as can_act
      FROM demo_players
      WHERE is_active = true
      ORDER BY RANDOM()
    `);
    
    // Filter to eligible players based on intensity and cooldown
    const eligiblePlayers = players.filter(p => p.can_act);
    const activeCount = Math.max(
      DEMO_CONFIG.minPlayers, 
      Math.min(Math.floor(eligiblePlayers.length * intensity), DEMO_CONFIG.maxPlayers)
    );
    const activePlayers = eligiblePlayers.slice(0, activeCount);
    
    const activities = [];
    const tradeGroups = new Map(); // Track trade groups for pairing
    
    for (const player of activePlayers) {
      // Skip based on aggression probability
      if (Math.random() > player.aggression) continue;
      
      // Check if player has sufficient balance (improvement #9)
      if (player.pcu_balance < 10) continue;
      
      const activity = await generatePlayerActivity(player, focus_gem_id, tradeGroups);
      if (activity) activities.push(activity);
    }
    
    res.json({
      tick: new Date().toISOString(),
      intensity,
      total_eligible: eligiblePlayers.length,
      players_activated: activePlayers.length,
      actions_generated: activities.length,
      activities
    });
  } catch (err) {
    res.status(500).json({ error: 'Tick generation failed', details: err.message });
  }
});

async function generatePlayerActivity(player, focusGemId = null, tradeGroups) {
  const actionType = Math.random() < DEMO_CONFIG.tradeProbability ? 'trade' : 'bid';
  
  // Get target gem
  let gemQuery = `
    SELECT id, gem_type, estimated_carat, status 
    FROM gems 
    WHERE status IN ('verified', 'listing', 'grading', 'precert', 'postcert')
  `;
  let params = [];
  
  if (focusGemId) {
    gemQuery += ` AND id = $1`;
    params = [focusGemId];
  } else {
    gemQuery += ` ORDER BY RANDOM() LIMIT 1`;
  }
  
  const { rows: [gem] } = await pool.query(gemQuery, params);
  if (!gem) return null;
  
  // Check player balance from tracking (improvement #9)
  if (player.pcu_balance < 10) return null;
  
  const basePrice = gem.estimated_carat * (1000 + Math.random() * 500);
  const maxQuantity = Math.floor(Math.min(player.pcu_balance * 0.05, 100));
  const quantity = Math.max(1, Math.floor(Math.random() * maxQuantity) + 1);
  
  // Validate price and quantity (improvement #2)
  const price = Math.max(0.01, basePrice * (0.95 + Math.random() * 0.1));
  if (price <= 0 || quantity <= 0) return null;
  
  let activity;
  let tradeGroupId = null;
  
  if (actionType === 'trade') {
    const side = Math.random() < 0.5 ? 'buy' : 'sell';
    
    // Improvement #7: Trade grouping
    if (tradeGroups.has(gem.id)) {
      // Pair with existing opposite side trade
      const existingGroup = tradeGroups.get(gem.id);
      if (existingGroup.side !== side) {
        tradeGroupId = existingGroup.trade_group;
      }
    }
    
    if (!tradeGroupId) {
      tradeGroupId = crypto.randomUUID();
      tradeGroups.set(gem.id, { trade_group: tradeGroupId, side });
    }
    
    // Record activity with trade group
    await pool.query(`
      INSERT INTO demo_activity (
        player_address, 
        player_name, 
        gem_id, 
        action, 
        quantity, 
        price, 
        side, 
        personality,
        trade_group,
        created_at
      )
      VALUES ($1, $2, $3, 'trade', $4, $5, $6, $7, $8, NOW())
    `, [player.player_address, player.player_name, gem.id, quantity, price, side, player.personality, tradeGroupId]);
    
    // Update player balance tracking (improvement #9)
    const balanceChange = side === 'sell' ? quantity * price : -(quantity * price);
    const newBalance = Math.max(0, player.pcu_balance + balanceChange);
    
    await pool.query(`
      UPDATE demo_players 
      SET pcu_balance = $1,
          last_action_at = NOW()
      WHERE player_address = $2
    `, [newBalance, player.player_address]);
    
    // Update actual PCU balance
    await pool.query(`
      UPDATE pcu_balances 
      SET balance = GREATEST(0, balance + $1),
          updated_at = NOW()
      WHERE wallet_address = $2
    `, [balanceChange, player.player_address]);
    
    activity = {
      player: player.player_name,
      personality: player.personality,
      action: 'trade',
      side,
      trade_group: tradeGroupId,
      gem_id: gem.id,
      gem_type: gem.gem_type,
      quantity,
      price: price.toFixed(2),
      total_value: (quantity * price).toFixed(2),
      new_balance: newBalance.toFixed(2)
    };
  } else {
    // Bid action
    const bidPrice = Math.max(0.01, basePrice * (0.90 + Math.random() * 0.15));
    
    await pool.query(`
      INSERT INTO demo_activity (
        player_address, 
        player_name, 
        gem_id, 
        action, 
        price, 
        personality,
        created_at
      )
      VALUES ($1, $2, $3, 'bid', $4, $5, NOW())
    `, [player.player_address, player.player_name, gem.id, bidPrice, player.personality]);
    
    // Update last action only (no balance change for bid)
    await pool.query(`
      UPDATE demo_players 
      SET last_action_at = NOW()
      WHERE player_address = $1
    `, [player.player_address]);
    
    activity = {
      player: player.player_name,
      personality: player.personality,
      action: 'bid',
      gem_id: gem.id,
      gem_type: gem.gem_type,
      bid_price: bidPrice.toFixed(2),
      message: `${player.player_name} placed bid on ${gem.gem_type}`
    };
  }
  
  return activity;
}

// ============================================
// DEMO DASHBOARD & STATUS
// ============================================

router.get('/demo/status', async (req, res) => {
  try {
    const { rows: activity } = await pool.query(`
      SELECT 
        COUNT(*) as total_actions,
        COUNT(DISTINCT player_address) as active_players,
        MAX(created_at) as last_activity,
        COUNT(DISTINCT trade_group) as completed_trades
      FROM demo_activity
      WHERE created_at > NOW() - INTERVAL '1 hour'
    `);
    
    const { rows: gems } = await pool.query(`
      SELECT 
        COUNT(DISTINCT gem_id) as active_gems,
        AVG(price) as avg_price,
        SUM(quantity) as volume_1h
      FROM demo_activity
      WHERE created_at > NOW() - INTERVAL '1 hour' 
      AND action = 'trade'
      AND price > 0
    `);
    
    const { rows: players } = await pool.query(`
      SELECT 
        player_name, 
        personality, 
        pcu_balance,
        last_action_at,
        CASE 
          WHEN last_action_at IS NULL THEN true
          WHEN EXTRACT(EPOCH FROM (NOW() - last_action_at)) > cooldown_seconds THEN true
          ELSE false
        END as can_act
      FROM demo_players
      WHERE is_active = true
      ORDER BY last_action_at DESC NULLS LAST
    `);
    
    // Get market depth summary (improvement #8)
    const { rows: depth } = await pool.query(`
      SELECT 
        SUM(simulated_bid_size) as total_bid_depth,
        SUM(simulated_ask_size) as total_ask_depth,
        COUNT(*) as active_markets
      FROM demo_market_state
    `);
    
    res.json({
      demo_mode: DEMO_CONFIG.enabled,
      status: 'active',
      activity: activity[0],
      market: gems[0],
      depth: depth[0],
      players: {
        total: players.length,
        ready_to_act: players.filter(p => p.can_act).length,
        total_balance: players.reduce((sum, p) => sum + parseFloat(p.pcu_balance), 0),
        roster: players.map(p => ({ 
          name: p.player_name, 
          personality: p.personality,
          balance: p.pcu_balance,
          ready: p.can_act
        }))
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Status lookup failed', details: err.message });
  }
});

// Get recent player activity log with trade grouping
router.get('/demo/activity', async (req, res) => {
  const { limit = 50, player, trade_group, gem_id } = req.query;
  
  let query = `
    SELECT 
      da.player_name, 
      da.personality, 
      da.action, 
      da.side, 
      da.quantity, 
      da.price,
      da.trade_group,
      g.gem_type, 
      g.estimated_carat, 
      da.created_at
    FROM demo_activity da
    JOIN gems g ON da.gem_id = g.id
    WHERE 1=1
  `;
  let params = [];
  let paramCount = 0;
  
  if (player) {
    paramCount++;
    query += ` AND da.player_name = $${paramCount}`;
    params.push(player);
  }
  
  if (trade_group) {
    paramCount++;
    query += ` AND da.trade_group = $${paramCount}`;
    params.push(trade_group);
  }
  
  if (gem_id) {
    paramCount++;
    query += ` AND da.gem_id = $${paramCount}`;
    params.push(gem_id);
  }
  
  paramCount++;
  query += ` ORDER BY da.created_at DESC LIMIT $${paramCount}`;
  params.push(limit);
  
  const { rows } = await pool.query(query, params);
  
  // Group by trade_group for paired trades
  const grouped = rows.reduce((acc, row) => {
    if (row.trade_group) {
      if (!acc.trades[row.trade_group]) {
        acc.trades[row.trade_group] = [];
      }
      acc.trades[row.trade_group].push(row);
    } else {
      acc.solo.push(row);
    }
    return acc;
  }, { trades: {}, solo: [] });
  
  res.json({
    activities: rows,
    count: rows.length,
    trade_groups: Object.keys(grouped.trades).length,
    paired_trades: grouped.trades
  });
});

// ============================================
// AUTO-PILOT MODE
// ============================================

// Enable/disable auto-pilot
router.post('/admin/demo/autopilot', requireAdmin, async (req, res) => {
  const { enabled, intensity = 0.7, interval_seconds = 30 } = req.body;
  
  if (enabled) {
    // Store autopilot config
    await pool.query(`
      UPDATE demo_config SET value = $1, updated_at = NOW() WHERE key = 'autopilot_intensity';
      UPDATE demo_config SET value = $2, updated_at = NOW() WHERE key = 'autopilot_interval';
      UPDATE demo_config SET value = 'true', updated_at = NOW() WHERE key = 'autopilot_enabled';
    `, [intensity.toString(), interval_seconds.toString()]);
    
    // Trigger immediate tick
    const tickResponse = await fetch(`${req.protocol}://${req.get('host')}/api/admin/demo/tick`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': req.headers.authorization 
      },
      body: JSON.stringify({ intensity })
    });
    
    const tickResult = await tickResponse.json();
    
    res.json({
      autopilot: 'enabled',
      intensity,
      interval_seconds,
      last_tick: tickResult
    });
  } else {
    await pool.query(`UPDATE demo_config SET value = 'false', updated_at = NOW() WHERE key = 'autopilot_enabled'`);
    res.json({ autopilot: 'disabled' });
  }
});

// Get autopilot status
router.get('/admin/demo/autopilot/status', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT key, value FROM demo_config WHERE key LIKE 'autopilot_%'`);
  const config = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
  
  res.json({
    enabled: config.autopilot_enabled === 'true',
    intensity: parseFloat(config.autopilot_intensity) || 0.7,
    interval_seconds: parseInt(config.autopilot_interval) || 30
  });
});

// ============================================
// CLEANUP & RESET
// ============================================

// Reset demo (clear activity, restore player balances)
router.post('/admin/demo/reset', requireAdmin, async (req, res) => {
  try {
    await pool.query('BEGIN');
    
    // Clear activity log
    await pool.query(`TRUNCATE demo_activity`);
    
    // Reset market states
    await pool.query(`TRUNCATE demo_market_state`);
    
    // Reset player balances to initial seeded values
    const { rows: players } = await pool.query(`
      SELECT player_address, min_pcu, max_pcu 
      FROM demo_players 
      WHERE is_active = true
    `);
    
    for (const player of players) {
      const resetBalance = Math.floor(player.min_pcu + (player.max_pcu - player.min_pcu) / 2);
      
      await pool.query(`
        UPDATE demo_players 
        SET pcu_balance = $1,
            last_action_at = NULL
        WHERE player_address = $2
      `, [resetBalance, player.player_address]);
      
      await pool.query(`
        DELETE FROM pcu_balances WHERE wallet_address = $1
      `, [player.player_address]);
    }
    
    // Disable demo mode
    await pool.query(`UPDATE demo_config SET value = 'false', updated_at = NOW() WHERE key = 'demo_mode_enabled'`);
    
    await pool.query('COMMIT');
    
    res.json({
      reset: true,
      players_reset: players.length,
      message: 'Demo reset complete. Run /admin/demo/init to restart with fresh balances.'
    });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Reset failed', details: err.message });
  }
});

// ============================================
// METADATA QUERY (Improvement #10)
// ============================================

// Query by metadata (example: find all trades with specific metadata tag)
router.get('/demo/activity/by-metadata', async (req, res) => {
  const { key, value, limit = 50 } = req.query;
  
  if (!key) {
    return res.status(400).json({ error: 'Metadata key required' });
  }
  
  const query = value 
    ? `SELECT * FROM demo_activity WHERE metadata @> $1 ORDER BY created_at DESC LIMIT $2`
    : `SELECT * FROM demo_activity WHERE metadata ? $1 ORDER BY created_at DESC LIMIT $2`;
  
  const params = value ? [{ [key]: value }, limit] : [key, limit];
  
  const { rows } = await pool.query(query, params);
  
  res.json({
    metadata_filter: { key, value },
    count: rows.length,
    activities: rows
  });
});
// ============================================
// EXPORTED HANDLERS FOR VERCEL
// ============================================

export async function getDemoPlayers(req, res) {
  try {
    return res.status(200).json({
      players: [
        { name: 'WhaleWatcher', personality: 'whale', aggression: 0.7 },
        { name: 'DiamondHands', personality: 'trader', aggression: 0.9 },
        { name: 'QuickFlip', personality: 'scalper', aggression: 0.85 },
        { name: 'GemGatherer', personality: 'collector', aggression: 0.3 }
      ]
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

export async function getDemoStatus(req, res) {
  try {
    return res.status(200).json({
      demo_mode: true,
      active_players: 4,
      volume_24h: '125,000 PCU',
      active_gems: 12
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ============================================
// EXPRESS ROUTES
// ============================================
router.get('/players', (req, res) => getDemoPlayers(req, res));
router.get('/status', (req, res) => getDemoStatus(req, res));

export default router;  // ← THIS STAYS AT THE VERY BOTTOM

