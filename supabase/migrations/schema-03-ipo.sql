-- schema-03-ipo.sql
-- PCAux Diamond Platform - Brick #3: IPO Engine Schema

-- IPOs (Initial PCU Offerings)
CREATE TABLE ipos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    
    -- Pricing
    ipo_price DECIMAL(10, 2) NOT NULL,
    total_pcus INTEGER NOT NULL DEFAULT 200,
    sold_pcus INTEGER DEFAULT 0,
    total_value DECIMAL(15, 2),
    pricing_method VARCHAR(20) DEFAULT 'manual', -- 'manual', 'dynamic'
    
    -- Timing
    status VARCHAR(20) DEFAULT 'pending', -- pending, open, closed, cancelled, failed
    opens_at TIMESTAMP,
    closes_at TIMESTAMP,
    duration_hours INTEGER DEFAULT 48,
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- IPO subscriptions (purchases)
CREATE TABLE ipo_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ipo_id UUID NOT NULL REFERENCES ipos(id),
    user_id UUID NOT NULL REFERENCES users(id),
    quantity INTEGER NOT NULL,
    price_per_pcu DECIMAL(10, 2) NOT NULL,
    total_cost DECIMAL(15, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'confirmed', -- confirmed, refunded, cancelled
    payment_intent_id VARCHAR(255), -- Stripe payment ID
    created_at TIMESTAMP DEFAULT NOW()
);

-- PCU balances
CREATE TABLE pcu_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    ipo_id UUID NOT NULL REFERENCES ipos(id),
    quantity INTEGER NOT NULL DEFAULT 0,
    reserved_for_redemption BOOLEAN DEFAULT false,
    acquired_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(user_id, diamond_id)
);

-- PCU transfers (secondary market)
CREATE TABLE pcu_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    from_user_id UUID NOT NULL REFERENCES users(id),
    to_user_id UUID NOT NULL REFERENCES users(id),
    quantity INTEGER NOT NULL,
    price_per_pcu DECIMAL(10, 2) NOT NULL,
    total_value DECIMAL(15, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- User USD balances
CREATE TABLE user_balances (
    user_id UUID PRIMARY KEY REFERENCES users(id),
    balance DECIMAL(15, 2) DEFAULT 0,
    reserved DECIMAL(15, 2) DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Treasury events
CREATE TABLE treasury_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ipo_id UUID NOT NULL REFERENCES ipos(id),
    event_type VARCHAR(50) NOT NULL, -- 'ipo_funded', 'grading_paid', 'jeweler_paid', 'redemption'
    amount DECIMAL(15, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- pending, locked, released, failed
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Jeweler payments
CREATE TABLE jeweler_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ipo_id UUID NOT NULL REFERENCES ipos(id),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    gross_amount DECIMAL(15, 2) NOT NULL,
    platform_fee DECIMAL(15, 2) NOT NULL,
    net_amount DECIMAL(15, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- pending, held, released, clawed_back
    paid_at TIMESTAMP,
    released_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Jeweler payment releases (staged)
CREATE TABLE jeweler_payment_releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES jeweler_payments(id),
    release_stage VARCHAR(20) NOT NULL, -- 'ipo_closed', 'grading_complete', 'redemption_fulfilled', 'final'
    amount DECIMAL(15, 2) NOT NULL,
    released_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending'
);

-- IPO creation metrics (for price discovery tuning)
CREATE TABLE ipo_creation_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ipo_id UUID NOT NULL REFERENCES ipos(id),
    suggested_price DECIMAL(10, 2),
    final_price DECIMAL(10, 2),
    confidence_score DECIMAL(3, 2), -- 0-1
    market_data_sample_size INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

-- IPO performance metrics
CREATE TABLE ipo_performance_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ipo_id UUID NOT NULL REFERENCES ipos(id),
    time_to_full_subscription INTERVAL,
    avg_order_size DECIMAL(10, 2),
    unique_investors INTEGER,
    fill_rate DECIMAL(5, 4), -- 0-1
    created_at TIMESTAMP DEFAULT NOW()
);

-- Refund queue
CREATE TABLE ipo_refund_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ipo_id UUID NOT NULL REFERENCES ipos(id),
    status VARCHAR(20) DEFAULT 'pending', -- pending, processing, completed, failed
    processed_at TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Job queue for pg-boss (external dependency, but track here)
CREATE TABLE job_queue_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_name VARCHAR(100) NOT NULL,
    reference_id UUID NOT NULL,
    status VARCHAR(20) DEFAULT 'scheduled', -- scheduled, completed, failed
    scheduled_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT
);

-- Indexes
CREATE INDEX idx_ipos_diamond ON ipos(diamond_id);
CREATE INDEX idx_ipos_jeweler ON ipos(jeweler_id);
CREATE INDEX idx_ipos_status ON ipos(status);
CREATE INDEX idx_ipos_closes ON ipos(closes_at) WHERE status = 'open';
CREATE INDEX idx_subscriptions_ipo ON ipo_subscriptions(ipo_id);
CREATE INDEX idx_subscriptions_user ON ipo_subscriptions(user_id);
CREATE INDEX idx_subscriptions_payment ON ipo_subscriptions(payment_intent_id);
CREATE INDEX idx_pcu_user ON pcu_balances(user_id);
CREATE INDEX idx_pcu_diamond ON pcu_balances(diamond_id);
CREATE INDEX idx_pcu_reserved ON pcu_balances(reserved_for_redemption) WHERE reserved_for_redemption = true;
CREATE INDEX idx_transfers_diamond ON pcu_transfers(diamond_id);
CREATE INDEX idx_transfers_from ON pcu_transfers(from_user_id);
CREATE INDEX idx_transfers_to ON pcu_transfers(to_user_id);
CREATE INDEX idx_treasury_ipo ON treasury_events(ipo_id);
CREATE INDEX idx_jeweler_payments_ipo ON jeweler_payments(ipo_id);
CREATE INDEX idx_jeweler_releases_payment ON jeweler_payment_releases(payment_id);
CREATE INDEX idx_metrics_ipo ON ipo_performance_metrics(ipo_id);
CREATE INDEX idx_refund_queue_ipo ON ipo_refund_queue(ipo_id);

-- Triggers
CREATE TRIGGER update_ipos_updated_at BEFORE UPDATE ON ipos
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pcu_balances_updated_at BEFORE UPDATE ON pcu_balances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_balances_updated_at BEFORE UPDATE ON user_balances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_jeweler_payments_updated_at BEFORE UPDATE ON jeweler_payments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
