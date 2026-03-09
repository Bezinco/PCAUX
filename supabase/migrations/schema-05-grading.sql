-- schema-05-grading.sql
-- PCAux Diamond Platform - Brick #5: Grading Pipeline

-- Grading submissions
CREATE TABLE grading_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    ipo_id UUID NOT NULL REFERENCES ipos(id),
    grader VARCHAR(10) NOT NULL CHECK (grader IN ('CGL', 'GIA', 'IGI', 'HRD')),
    service_level VARCHAR(20) DEFAULT 'standard',
    origin_report_requested BOOLEAN DEFAULT false,
    cost DECIMAL(10, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'submitted',
    
    certificate_number VARCHAR(50),
    report_url VARCHAR(500),
    final_carat DECIMAL(4, 2),
    final_color VARCHAR(10),
    final_clarity VARCHAR(10),
    final_cut VARCHAR(20),
    final_polish VARCHAR(20),
    final_symmetry VARCHAR(20),
    final_fluorescence VARCHAR(20),
    measurements JSONB,
    proportions JSONB,
    origin VARCHAR(100),
    comments TEXT,
    
    expected_completion_at TIMESTAMP,
    submitted_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Physical shipments
CREATE TABLE grading_shipments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id UUID NOT NULL REFERENCES grading_submissions(id),
    from_sleeve VARCHAR(50) NOT NULL REFERENCES sleeves(id),
    to_grader VARCHAR(10) NOT NULL,
    grader_address TEXT NOT NULL,
    tracking_number VARCHAR(100),
    insurance_value DECIMAL(15, 2),
    status VARCHAR(20) DEFAULT 'in_transit',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Graded valuations
CREATE TABLE graded_valuations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    submission_id UUID NOT NULL REFERENCES grading_submissions(id),
    base_value DECIMAL(15, 2) NOT NULL,
    graded_value DECIMAL(15, 2) NOT NULL,
    total_multiplier DECIMAL(6, 3) NOT NULL,
    color_mult DECIMAL(6, 3),
    clarity_mult DECIMAL(6, 3),
    cut_mult DECIMAL(6, 3),
    carat_mult DECIMAL(6, 3),
    calculated_at TIMESTAMP DEFAULT NOW()
);

-- Post-grade markets
CREATE TABLE post_grade_markets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    status VARCHAR(20) DEFAULT 'pending',
    opened_at TIMESTAMP,
    closed_at TIMESTAMP
);

-- Post-grade events
CREATE TABLE post_grade_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    event_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    scheduled_at TIMESTAMP,
    executed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Insurance claims (v1.1)
CREATE TABLE grading_insurance_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id UUID NOT NULL REFERENCES grading_submissions(id),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    claim_type VARCHAR(50) NOT NULL CHECK (claim_type IN ('lost_shipment', 'damage', 'theft', 'grading_error')),
    description TEXT NOT NULL,
    evidence_urls JSONB,
    claimed_amount DECIMAL(15, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    resolution_amount DECIMAL(15, 2),
    resolved_by UUID REFERENCES admins(id),
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Grading metrics (v1.1)
CREATE TABLE grading_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL,
    grader VARCHAR(10) NOT NULL,
    service_level VARCHAR(20) NOT NULL,
    submitted INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    time_days DECIMAL(6, 2),
    multiplier DECIMAL(6, 3),
    UNIQUE(date, grader, service_level)
);

-- Indexes
CREATE INDEX idx_grading_diamond ON grading_submissions(diamond_id);
CREATE INDEX idx_grading_ipo ON grading_submissions(ipo_id);
CREATE INDEX idx_grading_status ON grading_submissions(status);
CREATE INDEX idx_grading_expected ON grading_submissions(expected_completion_at) WHERE status = 'submitted';
CREATE INDEX idx_shipments_submission ON grading_shipments(submission_id);
CREATE INDEX idx_valuations_diamond ON graded_valuations(diamond_id);
CREATE INDEX idx_postgrade_diamond ON post_grade_markets(diamond_id);
CREATE INDEX idx_insurance_submission ON grading_insurance_claims(submission_id);
CREATE INDEX idx_insurance_status ON grading_insurance_claims(status);
CREATE INDEX idx_metrics_date ON grading_metrics(date, grader);

-- Triggers
CREATE TRIGGER update_grading_shipments_updated_at BEFORE UPDATE ON grading_shipments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
