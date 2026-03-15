// archive/bricks/brick-11-pcu-crypto.js
// PCAux Diamond Platform - Brick #11: PCU Crypto & Leaderboard (Vercel/Supabase)
// COMPLETE VERSION

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const GREASE_RATE = 0.025;
const REDEMPTION_COMMISSION = 0.05;
const REDEMPTION_LOCK_DAYS = 14;
const REDEMPTION_MAX_PCT = 0.50;
const CAP_THRESHOLD = 15000;

// ===== CORE PCU OPERATIONS =====

export async function mintPCU(req, res) {
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
  const { to_address, amount } = req.body;
  const from_address = req.wallet.address;

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
  const { pcu_amount } = req.body;
  const wallet_address = req.wallet.address;

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

// ===== LEADERBOARDS =====

export async function getLeaderboardConfig(req, res) {
  try {
    const { data: configs } = await supabase
      .from('leaderboard_configs')
      .select('leaderboard_key, gem_type, name_title, is_active')
      .eq('is_active', true)
      .order('leaderboard_key');

    return res.json({ leaderboards: configs });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load configs' });
  }
}

export async function renameLeaderboard(req, res) {
  const { key } = req.params;
  const { new_name } = req.body;

  try {
    await supabase
      .from('leaderboard_configs')
      .update({ name_title: new_name, updated_at: new Date().toISOString() })
      .eq('leaderboard_key', key);

    return res.json({ leaderboard_key: key, new_name, updated: true });
  } catch (err) {
    return res.status(500).json({ error: 'Rename failed' });
  }
}

export async function getLeaderboard(req, res) {
  const { key } = req.params;
  const { sort_by = 'carats', limit = 100 } = req.query;
  const sortColumn = sort_by === 'carats' ? 'carats_prorated' : 
                     sort_by === 'value' ? 'value_prorated' : 'shares_received';

  try {
    const { data: config } = await supabase
      .from('leaderboard_configs')
      .select('name_title')
      .eq('leaderboard_key', key)
      .single();

    if (!config) return res.status(404).json({ error: 'Leaderboard not found' });

    const { data: entries } = await supabase
      .from('leaderboard_entries')
      .select('wallet_address, carats_prorated, value_prorated, shares_received, gems_count, badges, last_activity_at')
      .eq('leaderboard_key', key)
      .gt('last_activity_at', new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString())
      .order(sortColumn, { ascending: false })
      .limit(limit);

    const ranked = entries?.map((r, i) => ({ rank: i + 1, ...r }));

    return res.json({
      leaderboard_key: key,
      name_title: config.name_title,
      sorted_by: sort_by,
      entries: ranked
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to load leaderboard' });
  }
}

// ===== BADGES =====

export async function getWalletBadges(req, res) {
  const { wallet_address } = req.params;

  try {
    const { data: badges } = await supabase
      .from('wallet_badges')
      .select('badge_key, badge_name, badge_icon, description, awarded_at')
      .eq('wallet_address', wallet_address)
      .order('awarded_at', { ascending: false });

    return res.json({ wallet: wallet_address, badges: badges || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load badges' });
  }
}

export async function awardBadge(req, res) {
  const { wallet_address, badge_key } = req.body;

  try {
    await supabase.from('wallet_badges').insert({
      wallet_address,
      badge_key,
      awarded_at: new Date().toISOString()
    });

    return res.json({ awarded: true, wallet: wallet_address, badge: badge_key });
  } catch (err) {
    return res.status(500).json({ error: 'Award failed' });
  }
}

// ===== STUFFED WALLETS =====

export async function getStuffedWallets(req, res) {
  const { gem_id, limit = 50 } = req.query;

  try {
    let query = supabase
      .from('stuffed_wallet_snapshots')
      .select(`
        wallet_address,
        gem_id,
        gems!inner(gem_type, carats),
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

export async function checkStuffed(req, res) {
  const { gem_id, wallet_address, current_value } = req.body;
  const over_cap = current_value - CAP_THRESHOLD;

  try {
    if (over_cap > 0) {
      await supabase.from('stuffed_wallet_snapshots').upsert({
        gem_id,
        wallet_address,
        current_value,
        over_cap_by: over_cap,
        status: 'stuffed',
        last_seen_at: new Date().toISOString()
      }, { onConflict: 'gem_id,wallet_address' });

      return res.json({ stuffed: true, over_cap_by: over_cap });
    } else {
      await supabase
        .from('stuffed_wallet_snapshots')
        .update({ status: 'relieved' })
        .eq('gem_id', gem_id)
        .eq('wallet_address', wallet_address);

      return res.json({ stuffed: false });
    }

  } catch (err) {
    return res.status(500).json({ error: 'Check failed' });
  }
}

// ===== BROKER AUCTIONS =====

export async function placeBrokerBid(req, res) {
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
        broker_wallet: req.wallet.address,
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

// ===== SYNDICATION =====

export async function voteSyndication(req, res) {
  const { gem_id } = req.params;
  const { vote_type, shares_voted, tx_hash } = req.body;

  try {
    const { data: holding } = await supabase
      .from('gem_holdings')
      .select('shares_owned')
      .eq('gem_id', gem_id)
      .eq('wallet_address', req.wallet.address)
      .single();

    if (!holding || holding.shares_owned < shares_voted) {
      return res.status(400).json({ error: 'Insufficient shares' });
    }

    await supabase.from('syndication_votes').upsert({
      gem_id,
      voter_address: req.wallet.address,
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

// ===== USER INFO =====

export async function getMyPCU(req, res) {
  try {
    const { data: balance } = await supabase
      .from('pcu_balances')
      .select('balance, general_funds, locked_until')
      .eq('wallet_address', req.wallet.address)
      .single();

    const { data: redemptions } = await supabase
      .from('pcu_redemptions')
      .select('id, pcu_amount, net_to_user, available_at, status')
      .eq('wallet_address', req.wallet.address)
      .in('status', ['pending', 'available'])
      .order('requested_at', { ascending: false });

    return res.json({
      wallet: req.wallet.address,
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
    // Total PCU in circulation
    const { data: balances } = await supabase
      .from('pcu_balances')
      .select('balance');
    
    const totalCirculation = balances?.reduce((sum, r) => sum + parseFloat(r.balance || 0), 0) || 0;

    // Total vault backing
    const { data: vaults } = await supabase
      .from('pcu_vault_backing')
      .select('vault_value_at_entry');
    
    const totalVaultBacking = vaults?.reduce((sum, r) => sum + parseFloat(r.vault_value_at_entry || 0), 0) || 0;

    // Active redemptions
    const { data: pendingRedemptions } = await supabase
      .from('pcu_redemptions')
      .select('pcu_amount')
      .eq('status', 'pending');
    
    const totalPendingRedemptions = pendingRedemptions?.reduce((sum, r) => sum + parseFloat(r.pcu_amount || 0), 0) || 0;

    // Total grease collected (treasury)
    const { data: treasury } = await supabase
      .from('pcu_balances')
      .select('balance')
      .eq('wallet_address', '0xTREASURY')
      .single();

    // Unique holders
    const { count: holderCount } = await supabase
      .from('pcu_balances')
      .select('*', { count: 'exact', head: true });

    // Recent transfer volume (24h)
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

// ===== Vercel Handler Export =====

export default async function handler(req, res) {
  const { path } = req.query;
  
  try {
    switch (path[0]) {
      // PCU Operations
      case 'mint': return await mintPCU(req, res);
      case 'transfer': return await transferPCU(req, res);
      case 'redeem': return await redeemPCU(req, res);
      case 'my-pcu': return await getMyPCU(req, res);
      case 'stats': return await getPCUStats(req, res);
      
      // Leaderboards
      case 'leaderboards': 
        if (path[1] === 'config') return await getLeaderboardConfig(req, res);
        if (path[1] && req.method === 'GET') return await getLeaderboard(req, res);
        if (path[1] && req.method === 'PATCH') return await renameLeaderboard(req, res);
        break;
      
      // Badges
      case 'badges':
        if (path[1]) return await getWalletBadges(req, res);
        if (req.method === 'POST') return await awardBadge(req, res);
        break;
      
      // Stuffed Wallets
      case 'stuffed':
        if (req.method === 'GET') return await getStuffedWallets(req, res);
        if (req.method === 'POST') return await checkStuffed(req, res);
        break;
      
      // Broker Auctions
      case 'broker':
        if (path[1] === 'bid' && req.method === 'POST') return await placeBrokerBid(req, res);
        if (path[1] === 'auctions') return await getActiveBrokerAuctions(req, res);
        if (path[1] === 'accept' && req.method === 'POST') return await acceptBrokerBid(req, res);
        break;
      
      // Syndication
      case 'syndicate':
        if (path[1] && req.method === 'POST') return await voteSyndication(req, res);
        break;
      
      default:
        return res.status(404).json({ error: 'Endpoint not found' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Internal error', details: err.message });
  }
}
