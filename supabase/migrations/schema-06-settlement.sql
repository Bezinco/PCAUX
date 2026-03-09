-- schema-06-settlement.sql
-- PCAux Diamond Platform - Brick #6: Settlement & Redemption

-- Redemptions
CREATE TABLE redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    user_id UUID NOT NULL REFERENCES users(id),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    coalition_id UUID,
    pcu_quantity INTEGER NOT NULL,
    redemption_type VARCHAR(20) DEFAULT 'single' CHECK (redemption_type IN ('single', 'coalition')),
    
    delivery_address TEXT NOT NULL,
    delivery_method VARCHAR(20) NOT NULL,
    insurance_required BOOLEAN DEFAULT true,
    insurance_fee DECIMAL(10, 2),
    delivery_fee DECIMAL(10, 2),
    
    gross_value DECIMAL(15, 2),
    penalty_amount DECIMAL(10, 2),
    net_value DECIMAL(15, 2),
    
    settlement_type VARCHAR(10) CHECK (settlement_type IN ('physical', 'cash')),
    status VARCHAR(20) DEFAULT 'pending',
    
    tracking_number VARCHAR(100),
    scheduled_delivery_date TIMESTAMP,
    requested_at TIMESTAMP DEFAULT NOW(),
    approved_at TIMESTAMP,
    delivered_at TIMESTAMP,
    settled_at TIMESTAMP,
    window_closes_at TIMESTAMP NOT NULL
);

-- Coalition redemptions (v1.1)
CREATE TABLE redemption_coalitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    total_pcus INTEGER NOT NULL,
    designated_recipient UUID NOT NULL REFERENCES users(id),
    delivery_address TEXT NOT NULL,
    delivery_method VARCHAR(20) NOT NULL,
    cash_distribution_method VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'forming',
    activated_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Coalition members
CREATE TABLE coalition_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coalition_id UUID NOT NULL REFERENCES redemption_coalitions(id),
    user_id UUID NOT NULL REFERENCES users(id),
    pcu_contribution INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'pending_confirmation',
    confirmed_at TIMESTAMP,
    UNIQUE(coalition_id, user_id)
);

-- Redemption right marketplace (v1.1)
CREATE TABLE redemption_right_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    redemption_id UUID NOT NULL REFERENCES redemptions(id),
    from_user_id UUID NOT NULL REFERENCES users(id),
    to_user_id UUID NOT NULL REFERENCES users(id),
    price DECIMAL(15, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending_acceptance',
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Jeweler payment releases
CREATE TABLE jeweler_payment_releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES jeweler_payments(id),
    release_stage VARCHAR(20) NOT NULL,
    amount DECIMAL(15, 2) NOT NULL,
    released_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending'
);

-- Auction listings (v1.1)
CREATE TABLE auction_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    auction_house VARCHAR(50) NOT NULL,
    reserve_price DECIMAL(15, 2) NOT NULL,
    description TEXT,
    status VARCHAR(20) DEFAULT 'submitted',
    submitted_at TIMESTAMP,
    estimated_close_date TIMESTAMP,
    sale_price DECIMAL(15, 2),
    net_proceeds DECIMAL(15, 2),
    sold_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Insurance claims (v1.1)
CREATE TABLE redemption_insurance_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    redemption_id UUID NOT NULL REFERENCES redemptions(id),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    user_id UUID NOT NULL REFERENCES users(id),
    claim_type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    evidence_urls JSONB,
    claimed_amount DECIMAL(15, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    resolution_amount DECIMAL(15, 2),
    resolved_by UUID REFERENCES admins(id),
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_redemptions_diamond ON redemptions(diamond_id);
CREATE INDEX idx_redemptions_user ON redemptions(user_id);
CREATE INDEX idx_redemptions_coalition ON redemptions(coalition_id);
CREATE INDEX idx_redemptions_status ON redemptions(status);
CREATE INDEX idx_coalitions_diamond ON redemption_coalitions(diamond_id);
CREATE INDEX idx_coalition_members_coalition ON coalition_members(coalition_id);
CREATE INDEX idx_coalition_members_user ON coalition_members(user_id);
CREATE INDEX idx_redemption_listings_redemption ON redemption_right_listings(redemption_id);
CREATE INDEX idx_auction_diamond ON auction_listings(diamond_id);
CREATE INDEX idx_auction_status ON auction_listings(status);
CREATE INDEX idx_insurance_redemption ON redemption_insurance_claims(redemption_id);

-- Triggers
CREATE TRIGGER update_redemptions_updated_at BEFORE UPDATE ON redemptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
