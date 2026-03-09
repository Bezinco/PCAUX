-- schema-07-quality-king-complete.sql
-- PCAux Diamond Platform - Complete Schema for Brick #7: Quality King Board
-- Includes: Core Quality King + Predictive Scoring + Gamification + Matchmaking + Tournaments

-- ============================================
-- CORE QUALITY KING TABLES (Existing)
-- ============================================

-- Jeweler score history (monthly snapshots)
CREATE TABLE IF NOT EXISTS jeweler_score_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    score INTEGER NOT NULL,
    tier VARCHAR(20) NOT NULL,
    metrics JSONB, -- snapshot of accuracy, multiplier, volume, fill_rate
    calculated_at TIMESTAMP DEFAULT NOW()
);

-- Accuracy breakdowns (per-stone detail for transparency)
CREATE TABLE IF NOT EXISTS grading_accuracy_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    
    -- Estimates
    estimated_color VARCHAR(10),
    estimated_clarity VARCHAR(10),
    estimated_cut VARCHAR(20),
    estimated_carat DECIMAL(4, 2),
    
    -- Actuals
    final_color VARCHAR(10),
    final_clarity VARCHAR(10),
    final_cut VARCHAR(20),
    final_carat DECIMAL(4, 2),
    
    -- Scoring
    color_accuracy DECIMAL(3, 2), -- 0-1
    clarity_accuracy DECIMAL(3, 2),
    cut_accuracy DECIMAL(3, 2),
    carat_accuracy DECIMAL(3, 2),
    overall_accuracy DECIMAL(3, 2),
    
    multiplier DECIMAL(6, 3),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Tier change events (for notifications)
CREATE TABLE IF NOT EXISTS tier_change_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    old_tier VARCHAR(20),
    new_tier VARCHAR(20),
    old_score INTEGER,
    new_score INTEGER,
    reason VARCHAR(100), -- 'grading_result', 'volume_milestone', 'manual_review'
    notified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- GAMIFICATION BADGES TABLES (New)
-- ============================================

-- Badge definitions reference table (optional, for admin)
CREATE TABLE IF NOT EXISTS badge_definitions (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    emoji VARCHAR(10),
    description TEXT,
    tier VARCHAR(20) NOT NULL, -- bronze, silver, gold, platinum
    points INTEGER DEFAULT 0,
    condition_type VARCHAR(50), -- 'accuracy', 'volume', 'streak', 'milestone'
    condition_value INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Jeweler earned badges
CREATE TABLE IF NOT EXISTS jeweler_badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    badge_id VARCHAR(50) NOT NULL,
    badge_name VARCHAR(100),
    badge_emoji VARCHAR(10),
    tier VARCHAR(20), -- bronze, silver, gold, platinum
    points INTEGER DEFAULT 0,
    earned_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(jeweler_id, badge_id)
);

-- Badge progress tracking (for badges not yet earned)
CREATE TABLE IF NOT EXISTS badge_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    badge_id VARCHAR(50) NOT NULL,
    current_value INTEGER DEFAULT 0,
    target_value INTEGER NOT NULL,
    progress_percent INTEGER GENERATED ALWAYS AS (LEAST(100, (current_value * 100 / NULLIF(target_value, 0)))) STORED,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(jeweler_id, badge_id)
);

-- ============================================
-- TOURNAMENT TABLES (New)
-- ============================================

-- Tournament definitions
CREATE TABLE IF NOT EXISTS tournaments (
    id VARCHAR(20) PRIMARY KEY, -- YYYY-MM format
    name VARCHAR(100),
    month INTEGER,
    year INTEGER,
    category VARCHAR(50), -- 'quality_kings', 'speed_demons', 'volume_champions', 'roi_legends'
    prize_pool DECIMAL(12, 2) DEFAULT 10000,
    status VARCHAR(20) DEFAULT 'active', -- active, completed, cancelled
    created_at TIMESTAMP DEFAULT NOW(),
    ended_at TIMESTAMP
);

-- Tournament rankings and prizes
CREATE TABLE IF NOT EXISTS tournament_rankings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id VARCHAR(20) REFERENCES tournaments(id),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    category VARCHAR(50),
    rank INTEGER,
    score DECIMAL(10, 4),
    metric_value DECIMAL(10, 4),
    graded_count INTEGER,
    prize_amount DECIMAL(12, 2),
    badge_awarded VARCHAR(50),
    claimed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tournament_id, jeweler_id, category)
);

-- ============================================
-- PREDICTIVE SCORING SUPPORT (New)
-- ============================================

-- Feature snapshots for ML training (optional, for advanced predictions)
CREATE TABLE IF NOT EXISTS jeweler_feature_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    snapshot_date DATE NOT NULL,
    features JSONB NOT NULL, -- normalized feature vector
    target_score INTEGER, -- actual score 30 days later (for training)
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(jeweler_id, snapshot_date)
);

-- Prediction logs (for accuracy tracking)
CREATE TABLE IF NOT EXISTS score_predictions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    predicted_at TIMESTAMP DEFAULT NOW(),
    horizon_days INTEGER NOT NULL, -- 30, 60, 90
    predicted_score INTEGER,
    confidence_lower INTEGER,
    confidence_upper INTEGER,
    actual_score INTEGER, -- filled in later when horizon reached
    error_percent DECIMAL(5, 2), -- calculated when actual known
    model_version VARCHAR(20)
);

-- ============================================
-- MATCHMAKING SUPPORT (New)
-- ============================================

-- Investor preferences (extend existing investors table concept)
CREATE TABLE IF NOT EXISTS investor_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investor_id UUID NOT NULL REFERENCES investors(id),
    risk_tolerance VARCHAR(20) DEFAULT 'moderate', -- conservative, moderate, aggressive
    preferred_tiers TEXT[], -- ['gold', 'platinum']
    min_jeweler_score INTEGER DEFAULT 0,
    max_volatility DECIMAL(5, 2) DEFAULT 1.0,
    preferred_categories TEXT[], -- diamond categories
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(investor_id)
);

-- Match history (track which matches led to trades)
CREATE TABLE IF NOT EXISTS match_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investor_id UUID NOT NULL REFERENCES investors(id),
    jeweler_id UUID NOT NULL REFERENCES jewelers(id),
    match_score DECIMAL(5, 4),
    traded BOOLEAN DEFAULT FALSE,
    return_percent DECIMAL(6, 2),
    matched_at TIMESTAMP DEFAULT NOW(),
    traded_at TIMESTAMP
);

-- ============================================
-- INDEXES
-- ============================================

-- Core indexes
CREATE INDEX IF NOT EXISTS idx_score_history_jeweler ON jeweler_score_history(jeweler_id);
CREATE INDEX IF NOT EXISTS idx_score_history_date ON jeweler_score_history(calculated_at);
CREATE INDEX IF NOT EXISTS idx_accuracy_logs_jeweler ON grading_accuracy_logs(jeweler_id);
CREATE INDEX IF NOT EXISTS idx_accuracy_logs_diamond ON grading_accuracy_logs(diamond_id);
CREATE INDEX IF NOT EXISTS idx_tier_changes_jeweler ON tier_change_events(jeweler_id);

-- Gamification indexes
CREATE INDEX IF NOT EXISTS idx_badges_jeweler ON jeweler_badges(jeweler_id);
CREATE INDEX IF NOT EXISTS idx_badges_earned ON jeweler_badges(earned_at);
CREATE INDEX IF NOT EXISTS idx_badge_progress_jeweler ON badge_progress(jeweler_id);
CREATE INDEX IF NOT EXISTS idx_badge_progress_percent ON badge_progress(progress_percent DESC);

-- Tournament indexes
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status, year, month);
CREATE INDEX IF NOT EXISTS idx_tournament_rankings_tournament ON tournament_rankings(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_rankings_category ON tournament_rankings(tournament_id, category);
CREATE INDEX IF NOT EXISTS idx_tournament_rankings_rank ON tournament_rankings(rank);
CREATE INDEX IF NOT EXISTS idx_tournament_rankings_jeweler ON tournament_rankings(jeweler_id);

-- Predictive indexes
CREATE INDEX IF NOT EXISTS idx_feature_snapshots_jeweler ON jeweler_feature_snapshots(jeweler_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_predictions_jeweler ON score_predictions(jeweler_id, predicted_at);

-- Matchmaking indexes
CREATE INDEX IF NOT EXISTS idx_investor_prefs_investor ON investor_preferences(investor_id);
CREATE INDEX IF NOT EXISTS idx_match_outcomes_investor ON match_outcomes(investor_id);
CREATE INDEX IF NOT EXISTS idx_match_outcomes_jeweler ON match_outcomes(jeweler_id);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Tier color helper
CREATE OR REPLACE FUNCTION TIER_COLOR(tier VARCHAR)
RETURNS VARCHAR AS $$
BEGIN
    RETURN CASE tier
        WHEN 'bronze' THEN '#CD7F32'
        WHEN 'silver' THEN '#C0C0C0'
        WHEN 'gold' THEN '#FFD700'
        WHEN 'platinum' THEN '#E5E4E2'
        WHEN 'diamond' THEN '#B9F2FF'
        ELSE '#808080'
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Calculate jeweler score function (for cron jobs)
CREATE OR REPLACE FUNCTION calculate_jeweler_score(p_jeweler_id UUID)
RETURNS TABLE(score INTEGER, tier VARCHAR, metrics JSONB) AS $$
DECLARE
    v_accuracy DECIMAL(3, 2);
    v_multiplier DECIMAL(6, 3);
    v_volume INTEGER;
    v_fill_rate DECIMAL(3, 2);
    v_graded_count INTEGER;
    v_final_score INTEGER;
    v_tier VARCHAR(20);
BEGIN
    -- Calculate metrics
    SELECT 
        AVG(CASE 
            WHEN d.estimated_color = d.final_color THEN 1.0
            WHEN ABS((ARRAY_POSITION(ARRAY['D','E','F','G','H','I','J'], d.estimated_color) - 
                      ARRAY_POSITION(ARRAY['D','E','F','G','H','I','J'], d.final_color))) = 1 THEN 0.7
            ELSE 0.1
        END),
        AVG(gv.total_multiplier),
        COUNT(*),
        AVG(COALESCE(i.sold_pcus::FLOAT / NULLIF(i.total_pcus, 0), 0))
    INTO v_accuracy, v_multiplier, v_graded_count, v_fill_rate
    FROM diamonds d
    LEFT JOIN graded_valuations gv ON d.id = gv.diamond_id
    LEFT JOIN ipos i ON d.id = i.diamond_id
    WHERE d.jeweler_id = p_jeweler_id 
    AND d.status IN ('graded', 'resolved', 'fully_redeemed');
    
    -- Calculate weighted score
    v_final_score := ROUND(
        LEAST(COALESCE(v_accuracy, 0), 1) * 1000 * 0.40 +
        LEAST(GREATEST(COALESCE(v_multiplier, 1) - 1, 0) / 2, 1) * 1000 * 0.25 +
        LEAST(COALESCE(v_graded_count, 0)::FLOAT / 50, 1) * 1000 * 0.20 +
        COALESCE(v_fill_rate, 0) * 1000 * 0.15
    );
    
    -- Determine tier
    v_tier := CASE
        WHEN v_final_score >= 2000 THEN 'diamond'
        WHEN v_final_score >= 1000 THEN 'platinum'
        WHEN v_final_score >= 500 THEN 'gold'
        WHEN v_final_score >= 200 THEN 'silver'
        ELSE 'bronze'
    END;
    
    RETURN QUERY SELECT 
        v_final_score,
        v_tier,
        jsonb_build_object(
            'avg_accuracy', v_accuracy,
            'avg_multiplier', v_multiplier,
            'graded_count', v_graded_count,
            'avg_fill_rate', v_fill_rate
        );
END;
$$ LANGUAGE plpgsql;

-- Update jeweler score and create history entry
CREATE OR REPLACE FUNCTION update_jeweler_score(p_jeweler_id UUID)
RETURNS VOID AS $$
DECLARE
    v_result RECORD;
    v_old_tier VARCHAR(20);
    v_new_tier VARCHAR(20);
BEGIN
    -- Get current tier
    SELECT quality_king_tier INTO v_old_tier FROM jewelers WHERE id = p_jeweler_id;
    
    -- Calculate new score
    SELECT * INTO v_result FROM calculate_jeweler_score(p_jeweler_id);
    
    -- Update jeweler
    UPDATE jewelers 
    SET quality_king_score = v_result.score,
        quality_king_tier = v_result.tier,
        updated_at = NOW()
    WHERE id = p_jeweler_id;
    
    -- Insert history
    INSERT INTO jeweler_score_history (jeweler_id, score, tier, metrics)
    VALUES (p_jeweler_id, v_result.score, v_result.tier, v_result.metrics);
    
    -- Check for tier change
    SELECT quality_king_tier INTO v_new_tier FROM jewelers WHERE id = p_jeweler_id;
    
    IF v_old_tier IS DISTINCT FROM v_new_tier THEN
        INSERT INTO tier_change_events (jeweler_id, old_tier, new_tier, old_score, new_score, reason)
        VALUES (p_jeweler_id, v_old_tier, v_new_tier, 
                (SELECT quality_king_score FROM jewelers WHERE id = p_jeweler_id),
                v_result.score, 'grading_result');
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- SEED DATA
-- ============================================

-- Insert default badge definitions
INSERT INTO badge_definitions (id, name, emoji, description, tier, points, condition_type, condition_value) VALUES
    ('first_home_run', 'First Blood', '🎯', 'Grade your first 2x+ multiplier stone', 'bronze', 100, 'milestone', 1),
    ('volume_rookie', 'Getting Started', '🌱', 'Grade 10 stones', 'bronze', 50, 'volume', 10),
    ('accuracy_king', 'Accuracy King', '👑', 'Maintain 90%+ accuracy over 20+ stones', 'silver', 500, 'accuracy', 90),
    ('volume_master', 'Volume Master', '💎', 'Grade 100 stones', 'gold', 1000, 'volume', 100),
    ('streak_master', 'Streak Master', '🔥', '10-day consecutive grading streak', 'gold', 750, 'streak', 10),
    ('perfectionist', 'Perfectionist', '💯', '10 consecutive stones with 95%+ accuracy', 'gold', 2000, 'accuracy', 95),
    ('diamond_hands', 'Diamond Hands', '💎🙌', '95%+ accuracy with $1M+ total volume', 'platinum', 5000, 'milestone', 1),
    ('unstoppable', 'Unstoppable', '⚡', '30-day consecutive grading streak', 'platinum', 2500, 'streak', 30),
    ('tournament_champion', 'Tournament Champion', '🏆', 'Win 1st place in a monthly tournament', 'platinum', 10000, 'milestone', 1),
    ('tournament_elite', 'Tournament Elite', '🥈', 'Finish in top 10 in a monthly tournament', 'gold', 2000, 'milestone', 10)
ON CONFLICT (id) DO NOTHING;
