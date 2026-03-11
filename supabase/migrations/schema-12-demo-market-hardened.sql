-- schema-12-demo-market-hardened.sql
-- PCaux Diamond Platform - Brick #12: Demo Market with Simulated Players
-- Hardened version with NOT NULL constraints, CHECK constraints, ENUMs, and performance indexes

-- ============================================
-- ENUM TYPES (Improvement #3)
-- ============================================

CREATE TYPE demo_personality AS ENUM (
    'whale',
    'trader',
    'collector',
    'scalper'
);

CREATE TYPE demo_action AS ENUM (
    'bid',
    'ask',
    'trade',
    'view',
    'ipo_subscribe'
);

CREATE TYPE trade_side AS ENUM (
    'buy',
    'sell'
);

-- ============================================
-- DEMO ACTIVITY LOG (Improvements #1, #2, #7, #10)
-- ============================================

CREATE TABLE demo_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_address VARCHAR(42) NOT NULL,
    player_name VARCHAR(50) NOT NULL,
    gem_id UUID NOT NULL REFERENCES gems(id),
    action demo_action NOT NULL,
    quantity INTEGER CHECK (quantity > 0),
    price DECIMAL(12, 2) CHECK (price > 0),
    side trade_side,
    personality demo_personality NOT NULL,
    trade_group UUID, -- Improvement #7: groups buy/sell sides of same trade
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- ============================================
-- SIMULATED PLAYER CONFIGURATION (Improvements #1, #4, #9)
-- ============================================

CREATE TABLE demo_players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_address VARCHAR(42) NOT NULL UNIQUE,
    player_name VARCHAR(50) NOT NULL,
    personality demo_personality NOT NULL,
    min_pcu DECIMAL(18, 8) NOT NULL CHECK (min_pcu >= 0),
    max_pcu DECIMAL(18, 8) NOT NULL CHECK (max_pcu >= min_pcu),
    aggression DECIMAL(3, 2) NOT NULL CHECK (aggression >= 0 AND aggression <= 1),
    cooldown_seconds INTEGER DEFAULT 30 NOT NULL CHECK (cooldown_seconds >= 0), -- Improvement #4
    pcu_balance DECIMAL(18, 8) DEFAULT 0 NOT NULL CHECK (pcu_balance >= 0), -- Improvement #9
    is_active BOOLEAN DEFAULT true NOT NULL,
    last_action_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- ============================================
-- DEMO MARKET STATE (Improvements #1, #8)
-- ============================================

CREATE TABLE demo_market_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gem_id UUID NOT NULL REFERENCES gems(id),
    simulated_bid DECIMAL(12, 2) NOT NULL CHECK (simulated_bid > 0), -- Improvement #2
    simulated_ask DECIMAL(12, 2) NOT NULL CHECK (simulated_ask > 0), -- Improvement #2
    simulated_bid_size DECIMAL(18, 8) DEFAULT 0 NOT NULL CHECK (simulated_bid_size >= 0), -- Improvement #8
    simulated_ask_size DECIMAL(18, 8) DEFAULT 0 NOT NULL CHECK (simulated_ask_size >= 0), -- Improvement #8
    last_trade_price DECIMAL(12, 2) CHECK (last_trade_price > 0), -- Improvement #2
    volume_24h DECIMAL(18, 8) DEFAULT 0 NOT NULL,
    player_activity_count INTEGER DEFAULT 0 NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
    UNIQUE(gem_id)
);

-- ============================================
-- DEMO CONFIGURATION (Improvement #1)
-- ============================================

CREATE TABLE demo_config (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- ============================================
-- PERFORMANCE INDEXES (Improvements #5, #6, #10)
-- ============================================

-- Player activity tracking
CREATE INDEX idx_demo_activity_player ON demo_activity(player_address);
CREATE INDEX idx_demo_activity_gem ON demo_activity(gem_id);
CREATE INDEX idx_demo_activity_time ON demo_activity(created_at);

-- Improvement #6: 24h rolling activity queries (big performance win)
CREATE INDEX idx_demo_activity_gem_time ON demo_activity(gem_id, created_at DESC);

-- Improvement #10: Metadata filtering (GIN for JSONB)
CREATE INDEX idx_demo_activity_metadata ON demo_activity USING GIN(metadata);

-- Player management
CREATE INDEX idx_demo_players_personality ON demo_players(personality, is_active);
CREATE INDEX idx_demo_players_active ON demo_players(is_active, last_action_at);

-- Improvement #5: Unique partial index for market state (enforces uniqueness, speeds updates)
CREATE UNIQUE INDEX idx_demo_market_gem_unique ON demo_market_state(gem_id);

-- ============================================
-- SEED DATA (Hardened)
-- ============================================

INSERT INTO demo_players (
    player_address, 
    player_name, 
    personality, 
    min_pcu, 
    max_pcu, 
    aggression, 
    cooldown_seconds, 
    pcu_balance,
    is_active
) VALUES
    ('0xPLAYER_WHALE_001', 'WhaleWatcher', 'whale', 5000, 20000, 0.70, 60, 15000, true),
    ('0xPLAYER_TRADER_002', 'DiamondHands', 'trader', 500, 3000, 0.90, 15, 2000, true),
    ('0xPLAYER_SCALPER_003', 'QuickFlip', 'scalper', 10, 200, 0.85, 5, 100, true),
    ('0xPLAYER_COLLECTOR_004', 'GemGatherer', 'collector', 100, 1000, 0.30, 120, 500, true),
    ('0xPLAYER_WHALE_005', 'VaultMaster', 'whale', 8000, 25000, 0.65, 45, 20000, true),
    ('0xPLAYER_TRADER_006', 'FlashTrader', 'trader', 800, 5000, 0.88, 20, 3500, true),
    ('0xPLAYER_COLLECTOR_007', 'StoneSaver', 'collector', 200, 1500, 0.35, 90, 800, true),
    ('0xPLAYER_SCALPER_008', 'DayTrader', 'scalper', 50, 500, 0.92, 10, 250, true)
ON CONFLICT (player_address) DO NOTHING;

-- Default config (all NOT NULL)
INSERT INTO demo_config (key, value) VALUES
    ('min_players', '3'),
    ('max_players', '8'),
    ('activity_interval_seconds', '30'),
    ('trade_probability', '0.4'),
    ('bid_probability', '0.6'),
    ('demo_mode_enabled', 'false'),
    ('max_price_volatility_pct', '5'),
    ('default_cooldown_seconds', '30')
ON CONFLICT (key) DO NOTHING;
