-- schema-09-frontend.sql
-- PCAux Diamond Platform - Schema for Brick #9: Frontend State & Analytics

-- User preferences and UI state
CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme VARCHAR(20) DEFAULT 'dark' CHECK (theme IN ('light', 'dark', 'auto')),
    default_chart_interval VARCHAR(10) DEFAULT '1h',
    default_order_type VARCHAR(10) DEFAULT 'limit',
    email_notifications BOOLEAN DEFAULT true,
    push_notifications BOOLEAN DEFAULT false,
    price_alerts_enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Price alerts set by users
CREATE TABLE price_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    diamond_id UUID NOT NULL REFERENCES diamonds(id) ON DELETE CASCADE,
    alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('above', 'below', 'percent_change')),
    target_price DECIMAL(12, 2),
    percent_threshold DECIMAL(5, 2),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'triggered', 'expired', 'cancelled')),
    triggered_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- User watchlists
CREATE TABLE watchlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Watchlist items
CREATE TABLE watchlist_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    watchlist_id UUID NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    diamond_id UUID NOT NULL REFERENCES diamonds(id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT NOW(),
    notes TEXT,
    UNIQUE(watchlist_id, diamond_id)
);

-- Frontend analytics (page views, interactions)
CREATE TABLE frontend_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    session_id VARCHAR(100) NOT NULL,
    page_path VARCHAR(255) NOT NULL,
    component_name VARCHAR(100),
    action VARCHAR(50) NOT NULL, -- 'view', 'click', 'trade', 'zoom_image', etc.
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Image viewing analytics (which images users examine)
CREATE TABLE image_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    image_type VARCHAR(50) NOT NULL,
    view_duration_seconds INTEGER,
    zoom_level DECIMAL(3, 1),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Trading UI state (draft orders, unsubmitted)
CREATE TABLE draft_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    diamond_id UUID NOT NULL REFERENCES diamonds(id) ON DELETE CASCADE,
    side VARCHAR(4) NOT NULL,
    order_type VARCHAR(10) DEFAULT 'limit',
    price DECIMAL(12, 2),
    quantity INTEGER,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Onboarding progress
CREATE TABLE onboarding_progress (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    step_completed INTEGER DEFAULT 0,
    total_steps INTEGER DEFAULT 5,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Tour/tooltip seen status
CREATE TABLE feature_tours (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tour_name VARCHAR(50) NOT NULL,
    completed BOOLEAN DEFAULT false,
    dismissed BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Indexes
CREATE INDEX idx_price_alerts_user ON price_alerts(user_id);
CREATE INDEX idx_price_alerts_diamond ON price_alerts(diamond_id);
CREATE INDEX idx_price_alerts_active ON price_alerts(status) WHERE status = 'active';
CREATE INDEX idx_watchlists_user ON watchlists(user_id);
CREATE INDEX idx_watchlist_items_watchlist ON watchlist_items(watchlist_id);
CREATE INDEX idx_frontend_analytics_session ON frontend_analytics(session_id);
CREATE INDEX idx_frontend_analytics_user ON frontend_analytics(user_id, created_at DESC);
CREATE INDEX idx_image_analytics_diamond ON image_analytics(diamond_id);
CREATE INDEX idx_draft_orders_user ON draft_orders(user_id);
CREATE INDEX idx_feature_tours_user ON feature_tours(user_id);

-- Triggers
CREATE TRIGGER update_user_preferences_updated_at BEFORE UPDATE ON user_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_draft_orders_updated_at BEFORE UPDATE ON draft_orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_onboarding_progress_updated_at BEFORE UPDATE ON onboarding_progress
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
