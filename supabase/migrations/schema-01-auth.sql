-- schema-01-auth.sql
-- PCAux Diamond Platform - Brick #1: Auth & Jeweler Onboarding
-- Complete schema for authentication, sessions, and security

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Speculators/Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(50) NOT NULL,
    role VARCHAR(20) DEFAULT 'speculator',
    status VARCHAR(20) DEFAULT 'active',
    kyc_status VARCHAR(20) DEFAULT 'pending',
    kyc_verified_at TIMESTAMP,
    quality_king_tier VARCHAR(20) DEFAULT 'novice',
    email_verified BOOLEAN DEFAULT false,
    mfa_enabled BOOLEAN DEFAULT false,
    mfa_secret VARCHAR(255),
    last_login TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Jewelers table (KYB required)
CREATE TABLE jewelers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    business_name VARCHAR(100) NOT NULL,
    business_address TEXT NOT NULL,
    tax_id VARCHAR(20) UNIQUE NOT NULL,
    phone VARCHAR(30) NOT NULL,
    website VARCHAR(255),
    contact_name VARCHAR(100) NOT NULL,
    quality_king_tier VARCHAR(20) DEFAULT 'bronze',
    quality_king_score INTEGER DEFAULT 0,
    listing_count INTEGER DEFAULT 0,
    successful_sales INTEGER DEFAULT 0,
    total_volume DECIMAL(15, 2) DEFAULT 0,
    avg_grade_accuracy DECIMAL(3, 2),
    status VARCHAR(20) DEFAULT 'pending',
    kyb_status VARCHAR(20) DEFAULT 'pending',
    kyb_verified_at TIMESTAMP,
    sleeve_id VARCHAR(50),
    email_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

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

-- KYB verification tracking
CREATE TABLE kyb_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    submitted_documents JSONB,
    reviewer_notes TEXT,
    reviewed_by UUID REFERENCES admins(id),
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- User sessions (enhanced with device fingerprinting)
CREATE TABLE user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    jeweler_id UUID REFERENCES jewelers(id) ON DELETE CASCADE,
    token_jti VARCHAR(255) NOT NULL,
    ip_address INET NOT NULL,
    user_agent TEXT,
    device_fingerprint VARCHAR(64),
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP,
    CONSTRAINT chk_session_user_or_jeweler CHECK (
        (user_id IS NOT NULL AND jeweler_id IS NULL) OR
        (user_id IS NULL AND jeweler_id IS NOT NULL)
    )
);

-- Failed login attempts (security monitoring)
CREATE TABLE failed_logins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    ip_address INET NOT NULL,
    user_agent TEXT,
    request_id UUID,
    timestamp TIMESTAMP DEFAULT NOW()
);

-- Rate limit blocks
CREATE TABLE rate_limit_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip INET NOT NULL,
    path VARCHAR(255),
    request_id UUID,
    timestamp TIMESTAMP DEFAULT NOW()
);

-- Password reset tokens
CREATE TABLE password_resets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    jeweler_id UUID REFERENCES jewelers(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT chk_user_or_jeweler CHECK (
        (user_id IS NOT NULL AND jeweler_id IS NULL) OR
        (user_id IS NULL AND jeweler_id IS NOT NULL)
    )
);

-- Email verifications
CREATE TABLE email_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    verified_at TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- MFA challenges
CREATE TABLE mfa_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    temp_token UUID NOT NULL,
    used_at TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- User preferences
CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme VARCHAR(20) DEFAULT 'dark',
    default_chart_interval VARCHAR(10) DEFAULT '1h',
    default_order_type VARCHAR(10) DEFAULT 'limit',
    email_notifications BOOLEAN DEFAULT true,
    push_notifications BOOLEAN DEFAULT false,
    price_alerts_enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_jewelers_email ON jewelers(email);
CREATE INDEX idx_jewelers_tax_id ON jewelers(tax_id);
CREATE INDEX idx_jewelers_quality_score ON jewelers(quality_king_score DESC);
CREATE INDEX idx_kyb_jeweler ON kyb_verifications(jeweler_id);
CREATE INDEX idx_kyb_status ON kyb_verifications(status);

-- Session indexes (critical for performance)
CREATE INDEX idx_user_sessions_token_jti ON user_sessions(token_jti);
CREATE INDEX idx_user_sessions_user_expires ON user_sessions(user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_user_sessions_jeweler_expires ON user_sessions(jeweler_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expires ON user_sessions(expires_at) WHERE revoked_at IS NULL;

-- Security indexes
CREATE INDEX idx_failed_logins_email ON failed_logins(email, timestamp DESC);
CREATE INDEX idx_failed_logins_ip ON failed_logins(ip_address, timestamp DESC);
CREATE INDEX idx_rate_blocks_ip ON rate_limit_blocks(ip, timestamp DESC);
CREATE INDEX idx_password_resets_user ON password_resets(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_password_resets_jeweler ON password_resets(jeweler_id) WHERE jeweler_id IS NOT NULL;
CREATE INDEX idx_email_verifications_user ON email_verifications(user_id, expires_at DESC);
CREATE INDEX idx_mfa_challenges_token ON mfa_challenges(temp_token, expires_at);

-- Helper function for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_jewelers_updated_at BEFORE UPDATE ON jewelers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_preferences_updated_at BEFORE UPDATE ON user_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Cleanup job function (run daily)
CREATE OR REPLACE FUNCTION cleanup_expired_sessions()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM user_sessions WHERE expires_at < NOW() - INTERVAL '30 days';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
