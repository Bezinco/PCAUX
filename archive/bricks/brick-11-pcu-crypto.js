// brick-11-pcu-crypto-complete.js
// PCaux Diamond Platform - Brick #11: PCU Crypto & Leaderboard (Final)
// Includes: Core PCU + Leaderboards + Badges + Stuffed Wallets + Broker Auctions

import express from 'express';
import { Pool } from 'pg';
import { requireAuth, requireWallet } from './brick-01-auth.js';

const router = express.Router();
const pool = new Pool();

const GREASE_RATE = 0.025;
const REDEMPTION_COMMISSION = 0.05;
const REDEMPTION_LOCK_DAYS = 14;
const REDEMPTION_MAX_PCT = 0.50;
const CAP_THRESHOLD = 15000;

// ============================================
// CORE PCU OPERATIONS
// ============================================

router.post('/admin/mint-pcu', requireAuth, async (req, res) => {
    const { gem_id, vault_value_usd, syndicate_members } = req.body;
    
    try {
        const pcuToIssue = vault_value_usd;
        
        for (const member of syndicate_members) {
            const { address, contribution_pct, shares_received } = member;
            const memberPcu = pcuToIssue * contribution_pct;
            
            await pool.query(`
                INSERT INTO pcu_balances (wallet_address, balance, general_funds, updated_at)
                VALUES ($1, $2, $2, NOW())
                ON CONFLICT (wallet_address) 
                DO UPDATE SET balance = pcu_balances.balance + $2, 
                            general_funds = pcu_balances.general_funds + $2,
                            updated_at = NOW()
            `, [address, memberPcu]);
        }
        
        await pool.query(`
            INSERT INTO pcu_vault_backing (gem_id, vault_value_at_entry, pcu_issued, syndication_date)
            VALUES ($1, $2, $3, NOW())
        `, [gem_id, vault_value_usd, pcuToIssue]);
        
        await updateLeaderboardsForVaulting(gem_id, syndicate_members);
        await checkAndAwardBadges(syndicate_members.map(m => m.address), 'og');
        
        res.json({ gem_id, pcu_issued: pcuToIssue, distributed_to: syndicate_members.length });
    } catch (err) {
        res.status(500).json({ error: 'Mint failed', details: err.message });
    }
});

router.post('/transfer', requireWallet, async (req, res) => {
    const { to_address, amount } = req.body;
    const from_address = req.wallet.address;
    
    try {
        const { rows: [sender] } = await pool.query(`
            SELECT balance FROM pcu_balances WHERE wallet_address = $1
        `, [from_address]);
        
        if (!sender || sender.balance < amount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        const grease = amount * GREASE_RATE;
        const netAmount = amount - grease;
        const pcauxTreasury = '0xTREASURY';
        
        await pool.query('BEGIN');
        
        await pool.query(`UPDATE pcu_balances SET balance = balance - $1, updated_at = NOW() WHERE wallet_address = $2`, [amount, from_address]);
        await pool.query(`INSERT INTO pcu_balances (wallet_address, balance, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (wallet_address) DO UPDATE SET balance = pcu_balances.balance + $2, updated_at = NOW()`, [to_address, netAmount]);
        await pool.query(`INSERT INTO pcu_balances (wallet_address, balance, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (wallet_address) DO UPDATE SET balance = pcu_balances.balance + $2, updated_at = NOW()`, [pcauxTreasury, grease]);
        await pool.query(`INSERT INTO pcu_transfers (from_address, to_address, amount, grease_fee, net_amount) VALUES ($1, $2, $3, $4, $5)`, [from_address, to_address, amount, grease, netAmount]);
        
        await pool.query('COMMIT');
        
        res.json({ from: from_address, to: to_address, gross: amount, grease, net: netAmount });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ error: 'Transfer failed', details: err.message });
    }
});

router.post('/redeem', requireWallet, async (req, res) => {
    const { pcu_amount } = req.body;
    const wallet_address = req.wallet.address;
    
    try {
        const { rows: [holder] } = await pool.query(`SELECT balance, general_funds FROM pcu_balances WHERE wallet_address = $1`, [wallet_address]);
        
        if (!holder || holder.balance < pcu_amount) {
            return res.status(400).json({ error: 'Insufficient PCU' });
        }
        
        const maxRedeemable = holder.general_funds * REDEMPTION_MAX_PCT;
        if (pcu_amount > maxRedeemable) {
            return res.status(400).json({ error: 'Exceeds 50% limit', max_redeemable: maxRedeemable });
        }
        
        const commission = pcu_amount * REDEMPTION_COMMISSION;
        const netToUser = pcu_amount - commission;
        const availableAt = new Date(Date.now() + REDEMPTION_LOCK_DAYS * 24 * 60 * 60 * 1000);
        
        await pool.query('BEGIN');
        await pool.query(`UPDATE pcu_balances SET balance = balance - $1, locked_until = $2, updated_at = NOW() WHERE wallet_address = $3`, [pcu_amount, availableAt, wallet_address]);
        await pool.query(`INSERT INTO pcu_redemptions (wallet_address, pcu_amount, redemption_value, commission_5pct, net_to_user, available_at) VALUES ($1, $2, $3, $4, $5, $6)`, [wallet_address, pcu_amount, pcu_amount, commission, netToUser, availableAt]);
        await pool.query('COMMIT');
        
        res.json({ pcu_amount, gross: pcu_amount, commission, net: netToUser, available_at: availableAt });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ error: 'Redemption failed', details: err.message });
    }
});

// ============================================
// LEADERBOARDS (Flexible Naming)
// ============================================

router.get('/leaderboards/config', async (req, res) => {
    const { rows } = await pool.query(`SELECT leaderboard_key, gem_type, name_title, is_active FROM leaderboard_configs WHERE is_active = true ORDER BY leaderboard_key`);
    res.json({ leaderboards: rows });
});

router.post('/admin/leaderboards/:key/rename', requireAuth, async (req, res) => {
    const { key } = req.params;
    const { new_name } = req.body;
    await pool.query(`UPDATE leaderboard_configs SET name_title = $1, updated_at = NOW() WHERE leaderboard_key = $2`, [new_name, key]);
    res.json({ leaderboard_key: key, new_name, updated: true });
});

router.get('/leaderboards/:key', async (req, res) => {
    const { key } = req.params;
    const { sort_by = 'carats', limit = 100 } = req.query;
    const sortColumn = sort_by === 'carats' ? 'carats_prorated' : sort_by === 'value' ? 'value_prorated' : 'shares_received';
    
    const { rows: [config] } = await pool.query(`SELECT name_title FROM leaderboard_configs WHERE leaderboard_key = $1`, [key]);
    if (!config) return res.status(404).json({ error: 'Leaderboard not found' });
    
    const { rows } = await pool.query(`
        SELECT wallet_address, carats_prorated, value_prorated, shares_received, gems_count, badges, last_activity_at
        FROM leaderboard_entries
        WHERE leaderboard_key = $1 AND last_activity_at > NOW() - INTERVAL '12 months'
        ORDER BY ${sortColumn} DESC LIMIT $2
    `, [key, limit]);
    
    const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));
    res.json({ leaderboard_key: key, name_title: config.name_title, sorted_by: sort_by, entries: ranked });
});

// ============================================
// BADGES (Deepseek Addition)
// ============================================

router.get('/badges/:wallet_address', async (req, res) => {
    const { rows } = await pool.query(`
        SELECT b.badge_key, b.badge_name, b.badge_icon, b.description, wb.awarded_at
        FROM wallet_badges wb
        JOIN badge_definitions b ON wb.badge_key = b.badge_key
        WHERE wb.wallet_address = $1 ORDER BY wb.awarded_at DESC
    `, [req.params.wallet_address]);
    res.json({ wallet: req.params.wallet_address, badges: rows });
});

router.post('/admin/badges/award', requireAuth, async (req, res) => {
    const { wallet_address, badge_key } = req.body;
    await pool.query(`INSERT INTO wallet_badges (wallet_address, badge_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [wallet_address, badge_key]);
    res.json({ awarded: true, wallet: wallet_address, badge: badge_key });
});

// ============================================
// STUFFED WALLETS (Deepseek Addition)
// ============================================

router.get('/stuffed-wallets', async (req, res) => {
    const { gem_id, limit = 50 } = req.query;
    const query = `
        SELECT s.wallet_address, s.gem_id, g.gem_type, g.carats, s.current_value, s.over_cap_by,
               s.first_detected_at, s.last_seen_at,
               (SELECT COUNT(*) FROM stuffed_wallet_snapshots s2 WHERE s2.wallet_address = s.wallet_address AND s2.status = 'stuffed') as total_gems_stuffed
        FROM stuffed_wallet_snapshots s
        JOIN gems g ON s.gem_id = g.id
        WHERE s.status = 'stuffed' ${gem_id ? 'AND s.gem_id = $1' : ''}
        ORDER BY s.over_cap_by DESC LIMIT $${gem_id ? '2' : '1'}
    `;
    const params = gem_id ? [gem_id, limit] : [limit];
    const { rows } = await pool.query(query, params);
    
    res.json({
        timestamp: new Date().toISOString(),
        total_stuffed: rows.length,
        total_trapped_value: rows.reduce((sum, r) => sum + parseFloat(r.over_cap_by), 0),
        wallets: rows
    });
});

// Trigger stuffed wallet check (called from auction system)
router.post('/admin/check-stuffed', requireAuth, async (req, res) => {
    const { gem_id, wallet_address, current_value } = req.body;
    const over_cap = current_value - CAP_THRESHOLD;
    
    if (over_cap > 0) {
        await pool.query(`
            INSERT INTO stuffed_wallet_snapshots (gem_id, wallet_address, current_value, over_cap_by, status)
            VALUES ($1, $2, $3, $4, 'stuffed')
            ON CONFLICT (gem_id, wallet_address) DO UPDATE
            SET current_value = $3, over_cap_by = $4, last_seen_at = NOW(), status = 'stuffed'
        `, [gem_id, wallet_address, current_value, over_cap]);
        
        res.json({ stuffed: true, over_cap_by: over_cap });
    } else {
        await pool.query(`UPDATE stuffed_wallet_snapshots SET status = 'relieved' WHERE gem_id = $1 AND wallet_address = $2`, [gem_id, wallet_address]);
        res.json({ stuffed: false });
    }
});

// ============================================
// BROKER AUCTIONS (Deepseek Addition)
// ============================================

router.post('/broker/bid', requireWallet, async (req, res) => {
    const { broker_name, pcu_amount, bid_price_usd, revenue_share_pct, terms } = req.body;
    if (pcu_amount < 1000) return res.status(400).json({ error: 'Minimum bid is 1,000 PCU' });
    
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const { rows: [bid] } = await pool.query(`
        INSERT INTO broker_auctions (broker_name, broker_wallet, pcu_amount, bid_price_usd, revenue_share_pct, terms, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [broker_name, req.wallet.address, pcu_amount, bid_price_usd, revenue_share_pct, terms, expires_at]);
    
    res.json({ bid_id: bid.id, status: 'pending_review', expires_at });
});

router.get('/broker/auctions/active', async (req, res) => {
    const { rows } = await pool.query(`
        SELECT broker_name, pcu_amount, bid_price_usd, revenue_share_pct, terms, expires_at, created_at
        FROM broker_auctions WHERE status = 'active' ORDER BY bid_price_usd DESC
    `);
    res.json({ active_bids: rows, total_bidding: rows.reduce((sum, r) => sum + parseFloat(r.pcu_amount), 0) });
});

router.post('/admin/broker/accept', requireAuth, async (req, res) => {
    const { auction_id } = req.body;
    const { rows: [auction] } = await pool.query(`SELECT * FROM broker_auctions WHERE id = $1`, [auction_id]);
    
    const totalValue = auction.pcu_amount * auction.bid_price_usd;
    await pool.query(`UPDATE broker_auctions SET status = 'accepted' WHERE id = $1`, [auction_id]);
    await pool.query(`INSERT INTO broker_auction_winners (auction_id, pcu_sold, total_value_usd) VALUES ($1, $2, $3)`, [auction_id, auction.pcu_amount, totalValue]);
    
    res.json({ accepted: true, pcu_sold: auction.pcu_amount, total_value: totalValue });
});

// ============================================
// SYNDICATION
// ============================================

router.post('/syndication/:gem_id/vote', requireWallet, async (req, res) => {
    const { gem_id } = req.params;
    const { vote_type, shares_voted, tx_hash } = req.body;
    
    const { rows: [holding] } = await pool.query(`SELECT shares_owned FROM gem_holdings WHERE gem_id = $1 AND wallet_address = $2`, [gem_id, req.wallet.address]);
    if (!holding || holding.shares_owned < shares_voted) return res.status(400).json({ error: 'Insufficient shares' });
    
    await pool.query(`
        INSERT INTO syndication_votes (gem_id, voter_address, shares_voted, vote_type, tx_hash)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (gem_id, voter_address) DO UPDATE SET shares_voted = $3, vote_type = $4, tx_hash = $5
    `, [gem_id, req.wallet.address, shares_voted, vote_type, tx_hash]);
    
    const { rows: [tally] } = await pool.query(`
        SELECT SUM(CASE WHEN vote_type = 'accept' THEN shares_voted ELSE 0 END) as accept_shares,
               COUNT(DISTINCT voter_address) as voter_count,
               (SELECT total_shares FROM gems WHERE id = $1) as total_shares
        FROM syndication_votes WHERE gem_id = $1
    `, [gem_id]);
    
    const accept_pct = tally.accept_shares / tally.total_shares;
    const threshold_reached = accept_pct >= 0.60 && tally.voter_count >= 2;
    
    res.json({ voted: true, accept_pct, voters: tally.voter_count, threshold_reached, status: threshold_reached ? 'ready_for_vaulting' : 'voting_open' });
});

// ============================================
// HELPERS
// ============================================

async function updateLeaderboardsForVaulting(gem_id, syndicate_members) {
    const { rows: [gem] } = await pool.query(`SELECT gem_type, carats, final_value_usd FROM gems WHERE id = $1`, [gem_id]);
    const leaderboard_key = gem.gem_type.toLowerCase();
    
    for (const member of syndicate_members) {
        const { address, ownership_pct, shares_received } = member;
        const carats_prorated = gem.carats * ownership_pct;
        const value_prorated = gem.final_value_usd * ownership_pct;
        
        await pool.query(`
            INSERT INTO leaderboard_entries (leaderboard_key, wallet_address, carats_prorated, value_prorated, shares_received, gems_count, last_activity_at)
            VALUES ($1, $2, $3, $4, $5, 1, NOW())
            ON CONFLICT (leaderboard_key, wallet_address)
            DO UPDATE SET carats_prorated = leaderboard_entries.carats_prorated + $3,
                          value_prorated = leaderboard_entries.value_prorated + $4,
                          shares_received = leaderboard_entries.shares_received + $5,
                          gems_count = leaderboard_entries.gems_count + 1,
                          last_activity_at = NOW()
        `, [leaderboard_key, address, carats_prorated, value_prorated, shares_received]);
    }
}

async function checkAndAwardBadges(wallet_addresses, badge_key) {
    for (const address of wallet_addresses) {
        await pool.query(`INSERT INTO wallet_badges (wallet_address, badge_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [address, badge_key]);
    }
}

// ============================================
// USER INFO
// ============================================

router.get('/my-pcu', requireWallet, async (req, res) => {
    const { rows: [balance] } = await pool.query(`SELECT balance, general_funds, locked_until FROM pcu_balances WHERE wallet_address = $1`, [req.wallet.address]);
    const { rows: redemptions } = await pool.query(`SELECT id, pcu_amount, net_to_user, available_at, status FROM pcu_redemptions WHERE wallet_address = $1 AND status IN ('pending', 'available') ORDER BY requested_at DESC`, [req.wallet.address]);
    
    res.json({
        wallet: req.wallet.address,
        pcu_balance: balance?.balance || 0,
        general_funds: balance?.general_funds || 0,
        locked_until: balance?.locked_until,
        pending_redemptions: redemptions,
        rules: { max_pct: REDEMPTION_MAX_PCT, lock_days: REDEMPTION_LOCK_DAYS, commission: REDEMPTION_COMMISSION }
    });
});

router.get('/stats', async (req, res) => {
    const { rows: [supply] } = await pool.query(`SELECT SUM(balance) as total_supply, SUM(general_funds) as total_fiat_backing FROM pcu_balances`);
    const { rows: [vault] } = await pool.query(`SELECT SUM(vault_value_at_entry) as total_vault_value, COUNT(*) as gems_vaulted FROM pcu_vault_backing WHERE status = 'active'`);
    const { rows: fees } = await pool.query(`SELECT SUM(grease_fee) as total_grease_30d FROM pcu_transfers WHERE created_at > NOW() - INTERVAL '30 days'`);
    
    res.json({
        pcu_supply: supply?.total_supply || 0,
        fiat_backing: supply?.total_fiat_backing || 0,
        vault_value: vault?.total_vault_value || 0,
        gems_vaulted: vault?.gems_vaulted || 0,
        fees_30d: fees?.total_grease_30d || 0,
        grease_rate: GREASE_RATE,
        redemption_commission: REDEMPTION_COMMISSION
    });
});

export default router;
