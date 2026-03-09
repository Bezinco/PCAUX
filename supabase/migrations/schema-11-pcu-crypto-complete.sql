-- schema-11-pcu-crypto-complete.sql
-- PCaux Diamond Platform - Brick #11: PCU Crypto & Leaderboard (Final)

-- ============================================
-- CORE PCU TABLES
-- ============================================

CREATE TABLE pcu_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(42) NOT NULL UNIQUE,
    balance DECIMAL(18, 8) DEFAULT 0,
    general_funds DECIMAL(18, 2) DEFAULT 0,
    locked_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE pcu_vault_backing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gem_id UUID NOT NULL REFERENCES gems(id),
    vault_value_at_entry DECIMAL(12, 2) NOT NULL,
    pcu_issued DECIMAL(18, 8) NOT NULL,
    syndication_date TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE pcu_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_address VARCHAR(42) NOT NULL,
    to_address VARCHAR(42) NOT NULL,
    amount DECIMAL(18, 8) NOT NULL,
    grease_fee DECIMAL(18, 8) NOT NULL,
    net_amount DECIMAL(18, 8) NOT NULL,
    tx_hash VARCHAR(66),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE pcu_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(42) NOT NULL,
    pcu_amount DECIMAL(18, 8) NOT NULL,
    redemption_value DECIMAL(12, 2) NOT NULL,
    commission_5pct DECIMAL(12, 2) NOT NULL,
    net_to_user DECIMAL(12, 2) NOT NULL,
    requested_at TIMESTAMP DEFAULT NOW(),
    available_at TIMESTAMP NOT NULL,
    claimed_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending'
);

-- ============================================
-- LEADERBOARD TABLES (Flexible Naming)
-- ============================================

CREATE TABLE leaderboard_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    leaderboard_key VARCHAR(50) NOT NULL UNIQUE,
    gem_type VARCHAR(20) NOT NULL,
    name_title VARCHAR(100) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE leaderboard_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    leaderboard_key VARCHAR(50) NOT NULL REFERENCES leaderboard_configs(leaderboard_key),
    wallet_address VARCHAR(42) NOT NULL,
    carats_prorated DECIMAL(10, 4) DEFAULT 0,
    value_prorated DECIMAL(12, 2) DEFAULT 0,
    shares_received INTEGER DEFAULT 0,
    gems_count INTEGER DEFAULT 0,
    badges TEXT[] DEFAULT '{}',
    last_activity_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(leaderboard_key, wallet_address)
);

-- ============================================
-- BADGE SYSTEM (Deepseek Addition)
-- ============================================

CREATE TABLE badge_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    badge_key VARCHAR(50) UNIQUE NOT NULL,
    badge_name VARCHAR(100) NOT NULL,
    badge_icon VARCHAR(10),
    description TEXT,
    criteria JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE wallet_badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(42) NOT NULL,
    badge_key VARCHAR(50) NOT NULL REFERENCES badge_definitions(badge_key),
    awarded_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(wallet_address, badge_key)
);

-- ============================================
-- STUFFED WALLET TRACKER (Deepseek Addition)
-- ============================================

CREATE TABLE stuffed_wallet_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gem_id UUID NOT NULL REFERENCES gems(id),
    wallet_address VARCHAR(42) NOT NULL,
    current_value DECIMAL(12, 2) NOT NULL,
    over_cap_by DECIMAL(12, 2) NOT NULL,
    cap_threshold DECIMAL(10, 2) DEFAULT 15000,
    first_detected_at TIMESTAMP DEFAULT NOW(),
    last_seen_at TIMESTAMP DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'stuffed'
);

-- ============================================
-- BROKER AUCTIONS (Deepseek Addition)
-- ============================================

CREATE TABLE broker_auctions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    broker_name VARCHAR(100) NOT NULL,
    broker_wallet VARCHAR(42) NOT NULL,
    pcu_amount DECIMAL(18, 8) NOT NULL,
    bid_price_usd DECIMAL(12, 2) NOT NULL,
    revenue_share_pct DECIMAL(5, 2) DEFAULT 0,
    terms TEXT,
    status VARCHAR(20) DEFAULT 'active',
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE broker_auction_winners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID NOT NULL REFERENCES broker_auctions(id),
    pcu_sold DECIMAL(18, 8) NOT NULL,
    total_value_usd DECIMAL(12, 2) NOT NULL,
    settled_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- SYNDICATION
-- ============================================

CREATE TABLE syndication_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gem_id UUID NOT NULL,
    voter_address VARCHAR(42) NOT NULL,
    shares_voted DECIMAL(18, 8) NOT NULL,
    vote_type VARCHAR(10) NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(gem_id, voter_address)
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_pcu_balances_wallet ON pcu_balances(wallet_address);
CREATE INDEX idx_pcu_vault_gem ON pcu_vault_backing(gem_id);
CREATE INDEX idx_pcu_transfers_from ON pcu_transfers(from_address);
CREATE INDEX idx_leaderboard_key_score ON leaderboard_entries(leaderboard_key, carats_prorated DESC);
CREATE INDEX idx_leaderboard_key_value ON leaderboard_entries(leaderboard_key, value_prorated DESC);
CREATE INDEX idx_leaderboard_key_shares ON leaderboard_entries(leaderboard_key, shares_received DESC);
CREATE INDEX idx_stuffed_active ON stuffed_wallet_snapshots(status, last_seen_at);
CREATE INDEX idx_stuffed_wallet ON stuffed_wallet_snapshots(wallet_address);
CREATE INDEX idx_broker_status ON broker_auctions(status, expires_at);
CREATE INDEX idx_syndication_gem ON syndication_votes(gem_id);

-- ============================================
-- SEED DATA
-- ============================================

INSERT INTO leaderboard_configs (leaderboard_key, gem_type, name_title) VALUES
    ('ruby', 'ruby', 'Ruby Raga'),
    ('sapphire', 'sapphire', 'Sapphire Sultan'),
    ('emerald', 'emerald', 'Emerald Earl')
ON CONFLICT (leaderboard_key) DO NOTHING;

INSERT INTO badge_definitions (badge_key, badge_name, badge_icon, description) VALUES
    ('predator', '🦈 Predator', '🦈', 'Top 10% in successful lowball bids'),
    ('whale', '🐋 Whale', '🐋', 'Top 10% by PCU holdings'),
    ('flipper', '🦊 Flipper', '🦊', '10+ trades/month, avg hold <7 days'),
    ('holder', '🏛️ Holder', '🏛️', 'No sales in >90 days'),
    ('sniper', '🎯 Sniper', '🎯', 'Top 10% in counter-acceptance speed'),
    ('og', '🧠 OG', '🧠', 'First 100 PCU holders'),
    ('diamond_hands', '💎 Diamond Hands', '💎', 'Held through 50%+ swing without selling'),
    ('estate', '👑 Estate', '👑', 'Sold family collection through PCaux'),
    ('sheikh', '🕌 Sheikh', '🕌', 'Multi-generational vault seller')
ON CONFLICT (badge_key) DO NOTHING;
