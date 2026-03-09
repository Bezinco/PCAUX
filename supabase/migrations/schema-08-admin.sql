-- schema-08-admin.sql
-- PCAux Diamond Platform - Schema for Brick #8: Admin Dashboard

-- Admin users
CREATE TABLE admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'super')),
    name VARCHAR(100) NOT NULL,
    active BOOLEAN DEFAULT true,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 4C change audit log
CREATE TABLE diamond_4c_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    field VARCHAR(50) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    reason TEXT NOT NULL,
    admin_id UUID NOT NULL REFERENCES admins(id),
    changed_at TIMESTAMP DEFAULT NOW()
);

-- Grader API configurations
CREATE TABLE grader_apis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grader_name VARCHAR(20) UNIQUE NOT NULL CHECK (grader_name IN ('CGL', 'GIA', 'IGI', 'HRD')),
    api_endpoint VARCHAR(500),
    api_key_encrypted TEXT, -- Store encrypted
    active BOOLEAN DEFAULT true,
    cost_standard DECIMAL(10, 2),
    cost_rush DECIMAL(10, 2),
    avg_turnaround_days DECIMAL(4, 2),
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Disputes
CREATE TABLE disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    user_id UUID NOT NULL REFERENCES users(id),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    redemption_id UUID REFERENCES redemptions(id),
    
    dispute_type VARCHAR(50) NOT NULL, -- 'grade_mismatch', 'delivery_damage', 'fake_stone', 'delivery_delay'
    description TEXT NOT NULL,
    evidence_urls JSONB, -- array of image URLs
    
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'resolved', 'escalated')),
    resolution VARCHAR(50), -- 'user_favor', 'jeweler_favor', 'split', 'refund', 'replacement'
    refund_amount DECIMAL(10, 2),
    resolution_notes TEXT,
    resolved_by UUID REFERENCES admins(id),
    resolved_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT NOW()
);

-- Dispute messages
CREATE TABLE dispute_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id UUID NOT NULL REFERENCES disputes(id),
    sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('user', 'jeweler', 'admin')),
    sender_id UUID NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_4c_changes_diamond ON diamond_4c_changes(diamond_id);
CREATE INDEX idx_disputes_status ON disputes(status);
CREATE INDEX idx_disputes_diamond ON disputes(diamond_id);
CREATE INDEX idx_dispute_messages_dispute ON dispute_messages(dispute_id);

-- Triggers
CREATE TRIGGER update_grader_apis_updated_at BEFORE UPDATE ON grader_apis
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
