// api/index.js
// PCAux Diamond Platform - Main API Router
// Integrates all 12 bricks for Vercel Serverless

import { createClient } from '@supabase/supabase-js';

// Initialize Supabase (used across multiple bricks)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ============================================
// BRICK 1: AUTH
// ============================================

async function requireAuth(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
  
  req.user = user;
  return user;
}

async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  
  const { data: admin } = await supabase
    .from('admins')
    .select('*')
    .eq('user_id', user.id)
    .single();
    
  if (!admin) {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  
  return user;
}

export async function register(req, res) {
  const { email, password, role } = req.body;
  
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { role } }
  });
  
  if (error) return res.status(400).json({ error: error.message });
  
  await supabase.from('profiles').insert({
    id: data.user.id,
    email,
    role,
    created_at: new Date().toISOString()
  });
  
  return res.status(201).json({ 
    message: 'Registration successful', 
    user_id: data.user.id 
  });
}

export async function login(req, res) {
  const { email, password } = req.body;
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  
  if (error) return res.status(401).json({ error: error.message });
  
  return res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user: data.user
  });
}

export async function logout(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  await supabase.auth.signOut(token);
  return res.json({ message: 'Logged out' });
}

// ============================================
// BRICK 2: SLEEVE / DIAMOND REGISTRATION
// ============================================

export async function registerSleeve(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { jeweler_id, location, security_level } = req.body;
  
  const { data, error } = await supabase
    .from('sleeves')
    .insert({
      jeweler_id,
      location,
      security_level,
      status: 'active',
      created_at: new Date().toISOString()
    })
    .select()
    .single();
    
  if (error) return res.status(500).json({ error: error.message });
  
  return res.status(201).json(data);
}

export async function createDiamondDraft(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { sleeve_id, estimated_carat, estimated_color, estimated_clarity } = req.body;
  
  const { data, error } = await supabase
    .from('gems')
    .insert({
      sleeve_id,
      owner_id: user.id,
      estimated_carat,
      estimated_color,
      estimated_clarity,
      status: 'draft',
      created_at: new Date().toISOString()
    })
    .select()
    .single();
    
  if (error) return res.status(500).json({ error: error.message });
  
  return res.status(201).json(data);
}

export async function getDiamond(req, res) {
  const { id } = req.query;
  
  const { data, error } = await supabase
    .from('gems')
    .select('*, sleeves(*)')
    .eq('id', id)
    .single();
    
  if (error) return res.status(404).json({ error: 'Gem not found' });
  
  return res.json(data);
}

export async function listDiamonds(req, res) {
  const { status, limit = 20, offset = 0 } = req.query;
  
  let query = supabase
    .from('gems')
    .select('*', { count: 'exact' })
    .range(offset, offset + limit - 1);
    
  if (status) query = query.eq('status', status);
  
  const { data, count, error } = await query;
  
  if (error) return res.status(500).json({ error: error.message });
  
  return res.json({ data, count, limit, offset });
}

// ============================================
// BRICK 3: IPO
// ============================================

export async function createIPO(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { gem_id, total_shares, price_per_share, opening_date } = req.body;
  
  // Verify ownership
  const { data: gem } = await supabase
    .from('gems')
    .select('owner_id, status')
    .eq('id', gem_id)
    .single();
    
  if (!gem || gem.owner_id !== user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  if (gem.status !== 'graded') {
    return res.status(400).json({ error: 'Gem must be graded before IPO' });
  }
  
  const { data, error } = await supabase
    .from('ipos')
    .insert({
      gem_id,
      total_shares,
      price_per_share,
      opening_date,
      status: 'upcoming',
      created_by: user.id
    })
    .select()
    .single();
    
  if (error) return res.status(500).json({ error: error.message });
  
  // Update gem status
  await supabase.from('gems').update({ status: 'listing' }).eq('id', gem_id);
  
  return res.status(201).json(data);
}

export async function buyPCUs(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { ipo_id, shares } = req.body;
  
  const { data: ipo } = await supabase
    .from('ipos')
    .select('*')
    .eq('id', ipo_id)
    .single();
    
  if (!ipo || ipo.status !== 'open') {
    return res.status(400).json({ error: 'IPO not available' });
  }
  
  const totalCost = shares * ipo.price_per_share;
  
  // Check balance
  const { data: balance } = await supabase
    .from('pcu_balances')
    .select('balance')
    .eq('wallet_address', user.id)
    .single();
    
  if (!balance || balance.balance < totalCost) {
    return res.status(400).json({ error: 'Insufficient PCU balance' });
  }
  
  // Record purchase
  await supabase.from('ipo_purchases').insert({
    ipo_id,
    buyer_id: user.id,
    shares,
    price_paid: totalCost,
    purchased_at: new Date().toISOString()
  });
  
  // Deduct balance
  await supabase.from('pcu_balances')
    .update({ balance: balance.balance - totalCost })
    .eq('wallet_address', user.id);
  
  // Update gem holdings
  await supabase.from('gem_holdings').upsert({
    gem_id: ipo.gem_id,
    wallet_address: user.id,
    shares_owned: shares,
    updated_at: new Date().toISOString()
  }, { onConflict: 'gem_id,wallet_address' });
  
  return res.json({ message: 'Purchase successful', shares, total_cost: totalCost });
}

export async function listIPOs(req, res) {
  const { status } = req.query;
  
  let query = supabase.from('ipos').select('*, gems(gem_type, estimated_carat)');
  
  if (status) query = query.eq('status', status);
  
  const { data, error } = await query;
  
  if (error) return res.status(500).json({ error: error.message });
  
  return res.json(data);
}

// ============================================
// BRICK 4: TRADING
// ============================================

export async function placeOrder(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { gem_id, side, price, shares } = req.body;
  
  // Verify holdings for sell orders
  if (side === 'sell') {
    const { data: holding } = await supabase
      .from('gem_holdings')
      .select('shares_owned')
      .eq('gem_id', gem_id)
      .eq('wallet_address', user.id)
      .single();
      
    if (!holding || holding.shares_owned < shares) {
      return res.status(400).json({ error: 'Insufficient shares' });
    }
  }
  
  const { data, error } = await supabase
    .from('orders')
    .insert({
      gem_id,
      trader_address: user.id,
      side,
      price,
      shares,
      status: 'open',
      created_at: new Date().toISOString()
    })
    .select()
    .single();
    
  if (error) return res.status(500).json({ error: error.message });
  
  return res.status(201).json(data);
}

export async function getOrderBook(req, res) {
  const { gem_id } = req.query;
  
  const { data: bids } = await supabase
    .from('orders')
    .select('*')
    .eq('gem_id', gem_id)
    .eq('side', 'buy')
    .eq('status', 'open')
    .order('price', { ascending: false });
    
  const { data: asks } = await supabase
    .from('orders')
    .select('*')
    .eq('gem_id', gem_id)
    .eq('side', 'sell')
    .eq('status', 'open')
    .order('price', { ascending: true });
    
  return res.json({ gem_id, bids: bids || [], asks: asks || [] });
}

export async function getMyOrders(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { data, error } = await supabase
    .from('orders')
    .select('*, gems(gem_type)')
    .eq('trader_address', user.id)
    .order('created_at', { ascending: false });
    
  if (error) return res.status(500).json({ error: error.message });
  
  return res.json(data);
}

// ============================================
// BRICK 5: GRADING
// ============================================

export async function submitForGrading(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { gem_id, grader_api_id } = req.body;
  
  const { data, error } = await supabase
    .from('grading_requests')
    .insert({
      gem_id,
      submitted_by: user.id,
      grader_api_id,
      status: 'pending',
      submitted_at: new Date().toISOString()
    })
    .select()
    .single();
    
  if (error) return res.status(500).json({ error: error.message });
  
  // Update gem status
  await supabase.from('gems').update({ status: 'grading' }).eq('id', gem_id);
  
  return res.status(201).json(data);
}

export async function getGradingResult(req, res) {
  const { gem_id } = req.query;
  
  const { data, error } = await supabase
    .from('grading_results')
    .select('*')
    .eq('gem_id', gem_id)
    .order('graded_at', { ascending: false })
    .limit(1)
    .single();
    
  if (error) return res.status(404).json({ error: 'No grading found' });
  
  return res.json(data);
}

// ============================================
// BRICK 6: SETTLEMENT
// ============================================

export async function requestRedemption(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { gem_id, shares } = req.body;
  
  const { data: holding } = await supabase
    .from('gem_holdings')
    .select('shares_owned')
    .eq('gem_id', gem_id)
    .eq('wallet_address', user.id)
    .single();
    
  if (!holding || holding.shares_owned < shares) {
    return res.status(400).json({ error: 'Insufficient shares' });
  }
  
  const { data, error } = await supabase
    .from('redemptions')
    .insert({
      gem_id,
      requester_address: user.id,
      shares,
      status: 'pending',
      requested_at: new Date().toISOString()
    })
    .select()
    .single();
    
  if (error) return res.status(500).json({ error: error.message });
  
  return res.status(201).json(data);
}

export async function getMyRedemptions(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { data, error } = await supabase
    .from('redemptions')
    .select('*, gems(gem_type)')
    .eq('requester_address', user.id)
    .order('requested_at', { ascending: false });
    
  if (error) return res.status(500).json({ error: error.message });
  
  return res.json(data);
}

// ============================================
// BRICK 7: QUALITY KING
// ============================================

export async function getLeaderboard(req, res) {
  const { limit = 10 } = req.query;
  
  const { data, error } = await supabase
    .from('jeweler_stats')
    .select('*')
    .order('quality_score', { ascending: false })
    .limit(limit);
    
  if (error) return res.status(500).json({ error: error.message });
  
  return res.json(data);
}

export async function getMyQualityKing(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { data, error } = await supabase
    .from('jeweler_stats')
    .select('*')
    .eq('jeweler_id', user.id)
    .single();
    
  if (error) return res.status(404).json({ error: 'No stats found' });
  
  return res.json(data);
}

// ============================================
// BRICK 8: ADMIN
// ============================================

export async function adminLogin(req, res) {
  const { email, password } = req.body;
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  
  if (error) return res.status(401).json({ error: error.message });
  
  // Check admin status
  const { data: admin } = await supabase
    .from('admins')
    .select('*')
    .eq('user_id', data.user.id)
    .single();
    
  if (!admin) {
    await supabase.auth.signOut();
    return res.status(403).json({ error: 'Not an admin' });
  }
  
  return res.json({
    access_token: data.session.access_token,
    admin: true
  });
}

export async function getAdminDashboard(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  
  const { count: totalUsers } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true });
    
  const { count: totalGems } = await supabase
    .from('gems')
    .select('*', { count: 'exact', head: true });
    
  const { count: pendingGrading } = await supabase
    .from('grading_requests')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');
    
  return res.json({
    total_users: totalUsers,
    total_gems: totalGems,
    pending_grading: pendingGrading,
    timestamp: new Date().toISOString()
  });
}

// ============================================
// BRICK 11: PCU CRYPTO (from your existing file)
// ============================================

const GREASE_RATE = 0.025;
const REDEMPTION_COMMISSION = 0.05;
const REDEMPTION_LOCK_DAYS = 14;
const REDEMPTION_MAX_PCT = 0.50;
const CAP_THRESHOLD = 15000;

export async function mintPCU(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  
  const { gem_id, vault_value_usd, syndicate_members } = req.body;
  
  try {
    const pcuToIssue = vault_value_usd;

    for (const member of syndicate_members) {
      const { address, contribution_pct } = member;
      const memberPcu = pcuToIssue * contribution_pct;

      await supabase.from('pcu_balances').upsert({
        wallet_address: address,
        balance: memberPcu,
        general_funds: memberPcu,
        updated_at: new Date().toISOString()
      }, { onConflict: 'wallet_address' });
    }

    await supabase.from('pcu_vault_backing').insert({
      gem_id,
      vault_value_at_entry: vault_value_usd,
      pcu_issued: pcuToIssue,
      syndication_date: new Date().toISOString()
    });

    return res.json({ 
      gem_id, 
      pcu_issued: pcuToIssue, 
      distributed_to: syndicate_members.length 
    });

  } catch (err) {
    return res.status(500).json({ error: 'Mint failed', details: err.message });
  }
}

export async function transferPCU(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { to_address, amount } = req.body;
  const from_address = user.id;

  if (from_address === to_address) {
    return res.status(400).json({ error: 'Cannot transfer to self' });
  }

  try {
    const { data: sender } = await supabase
      .from('pcu_balances')
      .select('balance')
      .eq('wallet_address', from_address)
      .single();

    if (!sender || sender.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const grease = amount * GREASE_RATE;
    const netAmount = amount - grease;
    const pcauxTreasury = '0xTREASURY';

    await supabase.from('pcu_balances').upsert({
      wallet_address: from_address,
      balance: sender.balance - amount,
      updated_at: new Date().toISOString()
    }, { onConflict: 'wallet_address' });

    await supabase.from('pcu_balances').upsert({
      wallet_address: to_address,
      balance: netAmount,
      updated_at: new Date().toISOString()
    }, { onConflict: 'wallet_address' });

    await supabase.from('pcu_balances').upsert({
      wallet_address: pcauxTreasury,
      balance: grease,
      updated_at: new Date().toISOString()
    }, { onConflict: 'wallet_address' });

    await supabase.from('pcu_transfers').insert({
      from_address,
      to_address,
      amount,
      grease_fee: grease,
      net_amount: netAmount,
      created_at: new Date().toISOString()
    });

    return res.json({ from: from_address, to: to_address, gross: amount, grease, net: netAmount });

  } catch (err) {
    return res.status(500).json({ error: 'Transfer failed', details: err.message });
  }
}

export async function redeemPCU(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { pcu_amount } = req.body;
  const wallet_address = user.id;

  try {
    const { data: holder } = await supabase
      .from('pcu_balances')
      .select('balance, general_funds')
      .eq('wallet_address', wallet_address)
      .single();

    if (!holder || holder.balance < pcu_amount) {
      return res.status(400).json({ error: 'Insufficient PCU' });
    }

    const maxRedeemable = holder.general_funds * REDEMPTION_MAX_PCT;
    if (pcu_amount > maxRedeemable) {
      return res.status(400).json({ error: 'Exceeds 50% limit', max_redeemable: maxRedeemable });
    }

    const commission = pcu_amount * REDEMPTION_COMMISSION;
    const netToUser = pcu_amount - commission;
    const availableAt = new Date(Date.now() + REDEMPTION_LOCK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    await supabase.from('pcu_balances').upsert({
      wallet_address,
      balance: holder.balance - pcu_amount,
      locked_until: availableAt,
      updated_at: new Date().toISOString()
    }, { onConflict: 'wallet_address' });

    await supabase.from('pcu_redemptions').insert({
      wallet_address,
      pcu_amount,
      redemption_value: pcu_amount,
      commission_5pct: commission,
      net_to_user: netToUser,
      available_at: availableAt,
      status: 'pending',
      requested_at: new Date().toISOString()
    });

    return res.json({ 
      pcu_amount, 
      gross: pcu_amount, 
      commission, 
      net: netToUser, 
      available_at: availableAt 
    });

  } catch (err) {
    return res.status(500).json({ error: 'Redemption failed', details: err.message });
  }
}

export async function getMyPCU(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const { data: balance } = await supabase
      .from('pcu_balances')
      .select('balance, general_funds, locked_until')
      .eq('wallet_address', user.id)
      .single();

    const { data: redemptions } = await supabase
      .from('pcu_redemptions')
      .select('id, pcu_amount, net_to_user, available_at, status')
      .eq('wallet_address', user.id)
      .in('status', ['pending', 'available'])
      .order('requested_at', { ascending: false });

    return res.json({
      wallet: user.id,
      pcu_balance: balance?.balance || 0,
      general_funds: balance?.general_funds || 0,
      locked_until: balance?.locked_until,
      pending_redemptions: redemptions || [],
      rules: { max_pct: REDEMPTION_MAX_PCT, lock_days: REDEMPTION_LOCK_DAYS, commission: REDEMPTION_COMMISSION }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to load PCU info' });
  }
}

export async function getPCUStats(req, res) {
  try {
    const { data: balances } = await supabase
      .from('pcu_balances')
      .select('balance');
    
    const totalCirculation = balances?.reduce((sum, r) => sum + parseFloat(r.balance || 0), 0) || 0;

    const { data: vaults } = await supabase
      .from('pcu_vault_backing')
      .select('vault_value_at_entry');
    
    const totalVaultBacking = vaults?.reduce((sum, r) => sum + parseFloat(r.vault_value_at_entry || 0), 0) || 0;

    const { data: pendingRedemptions } = await supabase
      .from('pcu_redemptions')
      .select('pcu_amount')
      .eq('status', 'pending');
    
    const totalPendingRedemptions = pendingRedemptions?.reduce((sum, r) => sum + parseFloat(r.pcu_amount || 0), 0) || 0;

    const { data: treasury } = await supabase
      .from('pcu_balances')
      .select('balance')
      .eq('wallet_address', '0xTREASURY')
      .single();

    const { count: holderCount } = await supabase
      .from('pcu_balances')
      .select('*', { count: 'exact', head: true });

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentTransfers } = await supabase
      .from('pcu_transfers')
      .select('amount')
      .gte('created_at', yesterday);
    
    const volume24h = recentTransfers?.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0) || 0;

    return res.json({
      timestamp: new Date().toISOString(),
      supply: {
        total_circulation: totalCirculation,
        total_vault_backing: totalVaultBacking,
        pending_redemptions: totalPendingRedemptions
      },
      treasury: {
        grease_collected: treasury?.balance || 0
      },
      holders: {
        total_wallets: holderCount || 0
      },
      volume: {
        transfers_24h: volume24h,
        transfer_count_24h: recentTransfers?.length || 0
      },
      constants: {
        grease_rate: GREASE_RATE,
        redemption_commission: REDEMPTION_COMMISSION,
        redemption_lock_days: REDEMPTION_LOCK_DAYS,
        redemption_max_pct: REDEMPTION_MAX_PCT,
        cap_threshold: CAP_THRESHOLD
      }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to load PCU stats', details: err.message });
  }
}

export async function getStuffedWallets(req, res) {
  const { gem_id, limit = 50 } = req.query;

  try {
    let query = supabase
      .from('stuffed_wallet_snapshots')
      .select(`
        wallet_address,
        gem_id,
        current_value,
        over_cap_by,
        first_detected_at,
        last_seen_at
      `)
      .eq('status', 'stuffed')
      .order('over_cap_by', { ascending: false })
      .limit(limit);

    if (gem_id) query = query.eq('gem_id', gem_id);

    const { data: wallets } = await query;

    return res.json({
      timestamp: new Date().toISOString(),
      total_stuffed: wallets?.length || 0,
      total_trapped_value: wallets?.reduce((sum, r) => sum + parseFloat(r.over_cap_by || 0), 0),
      wallets: wallets || []
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to load stuffed wallets' });
  }
}

export async function placeBrokerBid(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { broker_name, pcu_amount, bid_price_usd, revenue_share_pct, terms } = req.body;

  if (pcu_amount < 1000) {
    return res.status(400).json({ error: 'Minimum bid is 1,000 PCU' });
  }

  try {
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: bid } = await supabase
      .from('broker_auctions')
      .insert({
        broker_name,
        broker_wallet: user.id,
        pcu_amount,
        bid_price_usd,
        revenue_share_pct,
        terms,
        expires_at,
        status: 'pending_review',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    return res.json({ bid_id: bid.id, status: 'pending_review', expires_at });
  } catch (err) {
    return res.status(500).json({ error: 'Bid failed' });
  }
}

export async function getActiveBrokerAuctions(req, res) {
  try {
    const { data: auctions } = await supabase
      .from('broker_auctions')
      .select('broker_name, pcu_amount, bid_price_usd, revenue_share_pct, terms, expires_at, created_at')
      .eq('status', 'active')
      .order('bid_price_usd', { ascending: false });

    return res.json({
      active_bids: auctions || [],
      total_bidding: auctions?.reduce((sum, r) => sum + parseFloat(r.pcu_amount), 0) || 0
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load auctions' });
  }
}

export async function acceptBrokerBid(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  
  const { auction_id } = req.body;

  try {
    const { data: auction } = await supabase
      .from('broker_auctions')
      .select('*')
      .eq('id', auction_id)
      .single();

    const totalValue = auction.pcu_amount * auction.bid_price_usd;

    await supabase
      .from('broker_auctions')
      .update({ status: 'accepted' })
      .eq('id', auction_id);

    await supabase.from('broker_auction_winners').insert({
      auction_id,
      pcu_sold: auction.pcu_amount,
      total_value_usd: totalValue,
      accepted_at: new Date().toISOString()
    });

    return res.json({ accepted: true, pcu_sold: auction.pcu_amount, total_value: totalValue });
  } catch (err) {
    return res.status(500).json({ error: 'Acceptance failed' });
  }
}

export async function syndicationVote(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { gem_id } = req.query;
  const { vote_type, shares_voted, tx_hash } = req.body;

  try {
    const { data: holding } = await supabase
      .from('gem_holdings')
      .select('shares_owned')
      .eq('gem_id', gem_id)
      .eq('wallet_address', user.id)
      .single();

    if (!holding || holding.shares_owned < shares_voted) {
      return res.status(400).json({ error: 'Insufficient shares' });
    }

    await supabase.from('syndication_votes').upsert({
      gem_id,
      voter_address: user.id,
      shares_voted,
      vote_type,
      tx_hash,
      voted_at: new Date().toISOString()
    }, { onConflict: 'gem_id,voter_address' });

    const { data: tally } = await supabase
      .from('syndication_votes')
      .select('shares_voted, vote_type')
      .eq('gem_id', gem_id);

    const acceptShares = tally?.filter(v => v.vote_type === 'accept').reduce((sum, v) => sum + v.shares_voted, 0) || 0;
    const { data: gem } = await supabase.from('gems').select('total_shares').eq('id', gem_id).single();
    const acceptPct = acceptShares / (gem?.total_shares || 1);
    const thresholdReached = acceptPct >= 0.60 && (tally?.length || 0) >= 2;

    return res.json({
      voted: true,
      accept_pct: acceptPct,
      voters: tally?.length || 0,
      threshold_reached: thresholdReached,
      status: thresholdReached ? 'ready_for_vaulting' : 'voting_open'
    });

  } catch (err) {
    return res.status(500).json({ error: 'Vote failed' });
  }
}

// ============================================
// BRICK 12: DEMO MARKET (Simplified for Vercel)
// ============================================

// Mock demo players for frontend testing
const DEMO_PLAYERS = [
  { id: 'p1', name: 'DiamondKing', rank: 1, level: 85, diamonds: 15420, status: 'online' },
  { id: 'p2', name: 'RubyQueen', rank: 2, level: 82, diamonds: 12800, status: 'in-game' },
  { id: 'p3', name: 'EmeraldAce', rank: 3, level: 78, diamonds: 9450, status: 'offline' }
];

export async function getDemoPlayers(req, res) {
  return res.json({
    players: DEMO_PLAYERS,
    total: DEMO_PLAYERS.length,
    timestamp: new Date().toISOString()
  });
}

export async function getDemoStatus(req, res) {
  return res.json({
    platform: 'PCAUX Diamond',
    version: '1.0.0-demo',
    status: 'operational',
    metrics: {
      activePlayers: 1247,
      gamesInProgress: 89,
      totalDiamonds: 8943200
    },
    timestamp: new Date().toISOString()
  });
}

export async function getDemoActivity(req, res) {
  const activities = [
    { id: 1, player: 'DiamondKing', action: 'purchased 500 diamonds', time: '2m ago' },
    { id: 2, player: 'RubyQueen', action: 'reached level 83', time: '5m ago' },
    { id: 3, player: 'EmeraldAce', action: 'won tournament', time: '10m ago' }
  ];
  
  return res.json({ activities });
}

export async function getDemoFeed(req, res) {
  const feed = [
    { id: 1, title: 'Welcome to PCAUX', content: 'Experience next-gen diamond trading', priority: 'high' },
    { id: 2, title: 'Winter Championship', content: 'Prize pool: 50,000 diamonds', priority: 'medium' }
  ];
  
  return res.json({ feed });
}

// Admin demo controls (simplified)
export async function initDemo(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  
  return res.json({ 
    message: 'Demo initialized',
    players_seeded: DEMO_PLAYERS.length,
    pcu_balances: 'created'
  });
}

export async function tickDemo(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  
  return res.json({ 
    tick: new Date().toISOString(),
    actions_generated: Math.floor(Math.random() * 5) + 1,
    players_activated: DEMO_PLAYERS.filter(p => p.status === 'online').length
  });
}

export async function resetDemo(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  
  return res.json({ 
    reset: true,
    message: 'Demo reset complete'
  });
}

// ============================================
// MAIN ROUTER
// ============================================

export default async function handler(req, res) {
  const fullPath = req.url || '';
  const path = fullPath.replace(/^\/api\//, '').split('?')[0] || '';
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') return res.status(200).end();

  try {
    // Health check
    if (path === 'health' || path === '') {
      return res.status(200).json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        bricks: '1-12 loaded',
        path: fullPath
      });
    }

    if (path === 'hello') {
      return res.status(200).json({ message: 'hello from PCAUX' });
    }

    // === BRICK 1: AUTH ===
    if (path === 'auth/register' && method === 'POST') return await register(req, res);
    if (path === 'auth/login' && method === 'POST') return await login(req, res);
    if (path === 'auth/logout' && method === 'POST') return await logout(req, res);

    // === BRICK 2: SLEEVE ===
    if (path === 'sleeves/register' && method === 'POST') return await registerSleeve(req, res);
    if (path === 'diamonds/draft' && method === 'POST') return await createDiamondDraft(req, res);
    if (path.startsWith('diamonds/') && !path.includes('/') && method === 'GET') {
      req.query = { id: path.replace('diamonds/', '') };
      return await getDiamond(req, res);
    }
    if (path === 'diamonds' && method === 'GET') return await listDiamonds(req, res);

    // === BRICK 3: IPO ===
    if (path.endsWith('/ipo') && method === 'POST') {
      const gem_id = path.replace('diamonds/', '').replace('/ipo', '');
      req.body.gem_id = gem_id;
      return await createIPO(req, res);
    }
    if (path.endsWith('/buy') && method === 'POST') {
      const ipo_id = path.replace('ipos/', '').replace('/buy', '');
      req.body.ipo_id = ipo_id;
      return await buyPCUs(req, res);
    }
    if (path === 'ipos' && method === 'GET') return await listIPOs(req, res);

    // === BRICK 4: TRADING ===
    if (path.endsWith('/orders') && method === 'POST') {
      const gem_id = path.replace('diamonds/', '').replace('/orders', '');
      req.body.gem_id = gem_id;
      return await placeOrder(req, res);
    }
    if (path.endsWith('/orderbook') && method === 'GET') {
      req.query = { gem_id: path.replace('diamonds/', '').replace('/orderbook', '') };
      return await getOrderBook(req, res);
    }
    if (path === 'my/orders' && method === 'GET') return await getMyOrders(req, res);

    // === BRICK 5: GRADING ===
    if (path.endsWith('/grade') && method === 'POST') {
      req.body.gem_id = path.replace('diamonds/', '').replace('/grade', '');
      return await submitForGrading(req, res);
    }
    if (path.endsWith('/grade') && method === 'GET') {
      req.query = { gem_id: path.replace('diamonds/', '').replace('/grade', '') };
      return await getGradingResult(req, res);
    }

    // === BRICK 6: SETTLEMENT ===
    if (path.endsWith('/redeem') && method === 'POST') {
      req.body.gem_id = path.replace('diamonds/', '').replace('/redeem', '');
      return await requestRedemption(req, res);
    }
    if (path === 'my/redemptions' && method === 'GET') return await getMyRedemptions(req, res);

    // === BRICK 7: QUALITY KING ===
    if (path === 'quality-kings' && method === 'GET') return await getLeaderboard(req, res);
    if (path === 'jeweler/my-quality-king' && method === 'GET') return await getMyQualityKing(req, res);

    // === BRICK 8: ADMIN ===
    if (path === 'admin/login' && method === 'POST') return await adminLogin(req, res);
    if (path === 'admin/dashboard' && method === 'GET') return await getAdminDashboard(req, res);

    // === BRICK 11: PCU CRYPTO ===
    if (path === 'admin/mint-pcu' && method === 'POST') return await mintPCU(req, res);
    if (path === 'transfer' && method === 'POST') return await transferPCU(req, res);
    if (path === 'redeem' && method === 'POST') return await redeemPCU(req, res);
    if (path === 'my-pcu' && method === 'GET') return await getMyPCU(req, res);
    if (path === 'stats' && method === 'GET') return await getPCUStats(req, res);
    if (path === 'stuffed-wallets' && method === 'GET') return await getStuffedWallets(req, res);
    if (path === 'broker/bid' && method === 'POST') return await placeBrokerBid(req, res);
    if (path === 'broker/auctions/active' && method === 'GET') return await getActiveBrokerAuctions(req, res);
    if (path === 'admin/broker/accept' && method === 'POST') return await acceptBrokerBid(req, res);
    if (path.endsWith('/vote') && method === 'POST') {
      req.query = { gem_id: path.replace('syndication/', '').replace('/vote', '') };
      return await syndicationVote(req, res);
    }

    // === BRICK 12: DEMO ===
    if (path === 'demo/players' && method === 'GET') return await getDemoPlayers(req, res);
    if (path === 'demo/status' && method === 'GET') return await getDemoStatus(req, res);
    if (path === 'demo/activity' && method === 'GET') return await getDemoActivity(req, res);
    if (path === 'demo/feed' && method === 'GET') return await getDemoFeed(req, res);
    if (path === 'admin/demo/init' && method === 'POST') return await initDemo(req, res);
    if (path === 'admin/demo/tick' && method === 'POST') return await tickDemo(req, res);
    if (path === 'admin/demo/reset' && method === 'POST') return await resetDemo(req, res);

    // 404
    return res.status(404).json({ 
      error: 'Not found', 
      path: fullPath,
      available_endpoints: [
        'GET /api/health',
        'POST /api/auth/register',
        'POST /api/auth/login',
        'POST /api/diamonds/draft',
        'GET /api/diamonds',
        'POST /api/diamonds/:id/ipo',
        'GET /api/ipos',
        'POST /api/diamonds/:id/orders',
        'GET /api/diamonds/:id/orderbook',
        'POST /api/diamonds/:id/grade',
        'POST /api/diamonds/:id/redeem',
        'GET /api/my/orders',
        'GET /api/my/redemptions',
        'GET /api/quality-kings',
        'POST /api/transfer',
        'POST /api/redeem',
        'GET /api/my-pcu',
        'GET /api/stats',
        'GET /api/demo/players',
        'GET /api/demo/status'
      ]
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: 'Internal error', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
