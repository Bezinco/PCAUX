-- schema-02-sleeve.sql
-- PCAux Diamond Platform - Schema for Brick #2: Sleeve Verification & Image Capture

-- Sleeve hardware devices
CREATE TABLE sleeves (
    id VARCHAR(50) PRIMARY KEY, -- Hardware serial number
    status VARCHAR(20) DEFAULT 'active', -- active, sealed, maintenance, retired
    location VARCHAR(100), -- Physical location (store, warehouse)
    assigned_to UUID REFERENCES jewelers(id),
    current_diamond_id UUID, -- Diamond currently sealed
    sealed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Diamonds (assets)
CREATE TABLE diamonds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    sleeve_id VARCHAR(50) REFERENCES sleeves(id),
    
    -- Estimated 4Cs (jeweler's guess)
    estimated_carat DECIMAL(4, 2) NOT NULL,
    estimated_color VARCHAR(10),
    estimated_clarity VARCHAR(10),
    estimated_cut VARCHAR(20),
    
    -- Physical properties
    shape VARCHAR(20) NOT NULL,
    fluorescence VARCHAR(20) DEFAULT 'unknown',
    symmetry VARCHAR(20) DEFAULT 'unknown',
    polish VARCHAR(20) DEFAULT 'unknown',
    
    -- Provenance & story
    origin_story TEXT,
    
    -- Verification
    seal_hash VARCHAR(64), -- SHA256 tamper-evident hash
    images JSONB, -- 7-image packet URLs
    verified_at TIMESTAMP,
    
    -- Final grading (populated later)
    final_carat DECIMAL(4, 2),
    final_color VARCHAR(10),
    final_clarity VARCHAR(10),
    final_cut VARCHAR(20),
    final_certificate_url VARCHAR(255),
    grader VARCHAR(20), -- 'CGL', 'GIA', 'IGI'
    graded_at TIMESTAMP,
    
    -- Status workflow: draft -> verified -> listing -> grading -> graded -> resolved -> redeemed/withdrawn
    status VARCHAR(20) DEFAULT 'draft',
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Sleeve verification events (audit trail)
CREATE TABLE sleeve_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    sleeve_id VARCHAR(50) NOT NULL REFERENCES sleeves(id),
    daughter_id VARCHAR(50) NOT NULL, -- Who performed verification
    verification_notes TEXT,
    seal_hash VARCHAR(64) NOT NULL,
    images JSONB NOT NULL,
    verified_at TIMESTAMP DEFAULT NOW()
);

-- Sleeve release events (when stone removed)
CREATE TABLE sleeve_releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    sleeve_id VARCHAR(50) NOT NULL REFERENCES sleeves(id),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    release_reason VARCHAR(50) NOT NULL, -- 'ipo_cancelled', 'redemption_complete', 'withdrawal', 'grading_shipment'
    released_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_sleeves_status ON sleeves(status);
CREATE INDEX idx_sleeves_assigned ON sleeves(assigned_to);
CREATE INDEX idx_sleeves_diamond ON sleeves(current_diamond_id) WHERE current_diamond_id IS NOT NULL;
CREATE INDEX idx_diamonds_jeweler ON diamonds(jeweler_id);
CREATE INDEX idx_diamonds_status ON diamonds(status);
CREATE INDEX idx_diamonds_verified ON diamonds(verified_at) WHERE status = 'verified';
CREATE INDEX idx_verifications_diamond ON sleeve_verifications(diamond_id);
CREATE INDEX idx_verifications_sleeve ON sleeve_verifications(sleeve_id);

-- Trigger for updated_at
CREATE TRIGGER update_diamonds_updated_at BEFORE UPDATE ON diamonds
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sleeves_updated_at BEFORE UPDATE ON sleeves
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
