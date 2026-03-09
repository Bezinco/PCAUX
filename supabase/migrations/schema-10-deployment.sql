-- schema-10-deployment.sql
-- PCAux Diamond Platform - Schema for Brick #10: Deployment & Ops

-- Health check log
CREATE TABLE health_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('healthy', 'unhealthy', 'degraded')),
    response_time_ms INTEGER,
    error_message TEXT,
    checked_at TIMESTAMP DEFAULT NOW()
);

-- Deployment audit log
CREATE TABLE deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version VARCHAR(50) NOT NULL,
    commit_hash VARCHAR(40),
    deployed_by VARCHAR(100),
    status VARCHAR(20) DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed', 'rolled_back')),
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    error_log TEXT
);

-- Feature flags
CREATE TABLE feature_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) UNIQUE NOT NULL,
    enabled BOOLEAN DEFAULT false,
    description TEXT,
    rollout_percent INTEGER DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- System configuration
CREATE TABLE system_config (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_health_checks_service ON health_checks(service, checked_at DESC);
CREATE INDEX idx_health_checks_status ON health_checks(status);
CREATE INDEX idx_deployments_status ON deployments(status);

-- Initial config values
INSERT INTO system_config (key, value, description) VALUES
('max_ipo_duration_days', '90', 'Maximum allowed IPO pre-grade window'),
('min_jeweler_score_for_instant_listing', '500', 'Quality King score threshold for skip-review'),
('platform_fee_bps', '500', 'Base platform fee in basis points (5%)'),
('grading_buffer_percent', '10', 'Treasury reserve for grading costs'),
('auto_liquidation_threshold_days', '60', 'Days after grading to auto-liquidate unredeemed');

-- Triggers
CREATE TRIGGER update_feature_flags_updated_at BEFORE UPDATE ON feature_flags
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
