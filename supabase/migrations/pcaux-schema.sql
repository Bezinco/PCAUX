-- ============================================
-- PCAUX DIAMOND PLATFORM - COMPLETE DATABASE SCHEMA
-- All tables, functions, and triggers for Bricks 1-12
-- ============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- BRICK 1: AUTH & USERS
-- ============================================

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT CHECK (role IN ('jeweler', 'trader', 'admin')),
  kyb_status TEXT DEFAULT 'pending' CHECK (kyb_status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE admins (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  level INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- BRICK 2: SLEEVES & DIAMONDS (GEMS)
-- ============================================

CREATE TABLE sleeves (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  jeweler_id UUID REFERENCES auth.users(id),
  location TEXT,
  security_level INTEGER CHECK (security_level BETWEEN 1 AND 5),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'closed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE diamonds (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  sleeve_id UUID REFERENCES sleeves(id),
  owner_id UUID REFERENCES auth.users(id),
  
  -- 4Cs (estimated pre-grade)
  estimated_carat NUMERIC(8,2),
  estimated_color TEXT CHECK (estimated_color IN ('D', 'E', 'F', 'G', 'H', 'I', 'J', 'K')),
  estimated_clarity TEXT CHECK (estimated_clarity IN ('FL', 'IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2', 'I1', 'I2', 'I3')),
  estimated_cut TEXT,
  shape TEXT,
  
  -- Status workflow
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'grading', 'graded', 'listing', 'trading', 'redeemed', 'delivered')),
  
  -- Final grading (post-cert)
  final_carat NUMERIC(8,2),
  final_color TEXT,
  final_clarity TEXT,
  final_cut TEXT,
  cert_number TEXT UNIQUE,
  cert_file_url TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- BRICK 3: IPO & SYNDICATION
-- ============================================

CREATE TABLE ipos (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  diamond_id UUID REFERENCES diamonds(id),
  total_pcus INTEGER NOT NULL,
  ipo_price NUMERIC(12,2) NOT NULL,  -- USD per PCU
  sold_pcus INTEGER DEFAULT 0,
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  status TEXT DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'open', 'closed', 'cancelled')),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE syndication_votes (
  diamond_id UUID REFERENCES diamonds(id),
  voter_address UUID REFERENCES auth.users(id),
  shares_voted INTEGER,
  vote_type TEXT CHECK (vote_type IN ('accept', 'reject')),
  tx_hash TEXT,
  voted_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (diamond_id, voter_address)
);

-- ============================================
-- BRICK 4: TRADING (ORDERS & FILLS)
-- ============================================

CREATE TABLE orders (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  diamond_id UUID REFERENCES diamonds(id),
  user_id UUID REFERENCES auth.users(id),
  side TEXT CHECK (side IN ('buy', 'sell')),
  order_type TEXT DEFAULT 'limit' CHECK (order_type IN ('limit', 'market')),
  price NUMERIC(12,2),
  quantity INTEGER NOT NULL,
  filled_quantity INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'partial', 'filled', 'cancelled', 'expired')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fills (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  diamond_id UUID REFERENCES diamonds(id),
  buy_order_id UUID REFERENCES orders(id),
  sell_order_id UUID REFERENCES orders(id),
  buyer_id UUID REFERENCES auth.users(id),
  seller_id UUID REFERENCES auth.users(id),
  price NUMERIC(12,2) NOT NULL,
  quantity INTEGER NOT NULL,
  maker_fee NUMERIC(12,2) DEFAULT 0,  -- 25 bps
  taker_fee NUMERIC(12,2) DEFAULT 0,  -- 50 bps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- BRICK 5: GRADING
-- ============================================

CREATE TABLE grading_requests (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  diamond_id UUID REFERENCES diamonds(id),
  submitted_by UUID REFERENCES auth.users(id),
  grader_api_id TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'disputed')),
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE grading_results (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  diamond_id UUID REFERENCES diamonds(id),
  request_id UUID REFERENCES grading_requests(id),
  grader_id TEXT,
  carat NUMERIC(8,2),
  color TEXT,
  clarity TEXT,
  cut TEXT,
  cert_file_url TEXT,
  graded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- BRICK 6: SETTLEMENT & REDEMPTION
-- ============================================

CREATE TABLE redemptions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  diamond_id UUID REFERENCES diamonds(id),
  requester_id UUID REFERENCES auth.users(id),
  shares INTEGER NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cash_settled', 'cancelled')),
  redemption_type TEXT CHECK (redemption_type IN ('physical', 'cash')),
  tracking_number TEXT,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- ============================================
-- BRICK 7: QUALITY KING (JEWELER STATS)
-- ============================================

CREATE TABLE jeweler_stats (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  jeweler_id UUID REFERENCES auth.users(id) UNIQUE,
  quality_score NUMERIC DEFAULT 0,
  total_diamonds_graded INTEGER DEFAULT 0,
  avg_grading_accuracy NUMERIC DEFAULT 0,
  reputation_tier TEXT DEFAULT 'bronze' CHECK (reputation_tier IN ('bronze', 'silver', 'gold', 'platinum', 'diamond')),
  cap_bonus_earned NUMERIC DEFAULT 0,
  total_fees_earned NUMERIC DEFAULT 0,
  badges JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- BRICK 8: ADMIN (DISPUTES, KYB)
-- ============================================

CREATE TABLE disputes (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  diamond_id UUID REFERENCES diamonds(id),
  raised_by UUID REFERENCES auth.users(id),
  reason TEXT,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'resolved', 'rejected')),
  resolution TEXT,
  resolved_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE kyb_reviews (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  business_name TEXT,
  registration_number TEXT,
  documents JSONB,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES auth.users(id),
  notes TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

-- ============================================
-- BRICK 11: PCU CRYPTO
-- ============================================

CREATE TABLE pcu_balances (
  wallet_address TEXT PRIMARY KEY,  -- Can be user_id or external wallet
  user_id UUID REFERENCES auth.users(id),
  balance NUMERIC DEFAULT 0,
  general_funds NUMERIC DEFAULT 0,  -- Redeemable portion
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE pcu_transfers (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  grease_fee NUMERIC DEFAULT 0,  -- 2.5%
  net_amount NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE pcu_redemptions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  wallet_address TEXT REFERENCES pcu_balances(wallet_address),
  pcu_amount NUMERIC NOT NULL,
  redemption_value NUMERIC,
  commission_5pct NUMERIC,
  net_to_user NUMERIC,
  available_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'completed', 'cancelled')),
  requested_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE pcu_vault_backing (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  diamond_id UUID REFERENCES diamonds(id),
  vault_value_at_entry NUMERIC,
  pcu_issued NUMERIC,
  syndication_date TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE stuffed_wallet_snapshots (
  gem_id UUID REFERENCES diamonds(id),
  wallet_address TEXT,
  current_value NUMERIC,
  over_cap_by NUMERIC,
  status TEXT CHECK (status IN ('stuffed', 'relieved')),
  first_detected_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (gem_id, wallet_address)
);

CREATE TABLE broker_auctions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  broker_name TEXT,
  broker_wallet TEXT,
  pcu_amount NUMERIC,
  bid_price_usd NUMERIC,
  revenue_share_pct NUMERIC,
  terms TEXT,
  expires_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'active', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE broker_auction_winners (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  auction_id UUID REFERENCES broker_auctions(id),
  pcu_sold NUMERIC,
  total_value_usd NUMERIC,
  accepted_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- BRICK 12: DEMO MARKET
-- ============================================

CREATE TABLE demo_players (
  player_address TEXT PRIMARY KEY,
  player_name TEXT,
  personality TEXT CHECK (personality IN ('aggressive', 'conservative', 'random')),
  aggression NUMERIC DEFAULT 0.5,  -- 0-1 probability of acting
  cooldown_seconds INTEGER DEFAULT 60,
  min_pcu INTEGER DEFAULT 1000,
  max_pcu INTEGER DEFAULT 10000,
  pcu_balance INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  last_action_at TIMESTAMPTZ
);

CREATE TABLE demo_activity (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  player_address TEXT,
  player_name TEXT,
  gem_id UUID,
  action TEXT CHECK (action IN ('trade', 'bid')),
  quantity INTEGER,
  price NUMERIC,
  side TEXT CHECK (side IN ('buy', 'sell')),
  personality TEXT,
  trade_group UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE demo_market_state (
  gem_id UUID PRIMARY KEY REFERENCES diamonds(id),
  simulated_bid NUMERIC,
  simulated_ask NUMERIC,
  simulated_bid_size INTEGER,
  simulated_ask_size INTEGER,
  last_trade_price NUMERIC,
  player_activity_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE demo_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- SHARED: USER BALANCES (USD)
-- ============================================

CREATE TABLE user_balances (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  balance NUMERIC DEFAULT 0,      -- Available USD
  reserved NUMERIC DEFAULT 0,   -- Reserved for buy orders
  currency TEXT DEFAULT 'USD',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Gem holdings (PCUs per diamond)
CREATE TABLE gem_holdings (
  user_id UUID REFERENCES auth.users(id),
  diamond_id UUID REFERENCES diamonds(id),
  quantity INTEGER DEFAULT 0,
  avg_cost_basis NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, diamond_id)
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

CREATE INDEX idx_diamonds_status ON diamonds(status);
CREATE INDEX idx_diamonds_jeweler ON diamonds(owner_id);
CREATE INDEX idx_orders_diamond_status ON orders(diamond_id, status) WHERE status IN ('open', 'partial');
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_fills_diamond ON fills(diamond_id);
CREATE INDEX idx_fills_buyer ON fills(buyer_id);
CREATE INDEX idx_fills_seller ON fills(seller_id);
CREATE INDEX idx_pcu_balances_user ON pcu_balances(user_id);
CREATE INDEX idx_pcu_transfers_from ON pcu_transfers(from_address);
CREATE INDEX idx_pcu_transfers_to ON pcu_transfers(to_address);
CREATE INDEX idx_redemptions_user ON redemptions(requester_id);
CREATE INDEX idx_ipos_status ON ipos(status);
CREATE INDEX idx_demo_activity_player ON demo_activity(player_address);
CREATE INDEX idx_demo_activity_gem ON demo_activity(gem_id);

-- ============================================
-- ATOMIC FUNCTIONS (BRICK 4)
-- ============================================

CREATE OR REPLACE FUNCTION place_order_atomic(
  p_user_id UUID,
  p_diamond_id UUID,
  p_side TEXT,
  p_price NUMERIC,
  p_quantity INTEGER,
  p_order_type TEXT DEFAULT 'limit'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_diamond RECORD;
  v_balance RECORD;
  v_total_cost NUMERIC;
  v_available NUMERIC;
  v_pending_qty INTEGER;
  v_ipo_closed_at TIMESTAMPTZ;
  v_window_end TIMESTAMPTZ;
  v_order_id UUID;
BEGIN
  SELECT d.*, i.closes_at as ipo_closed_at
  INTO v_diamond
  FROM diamonds d
  JOIN ipos i ON i.diamond_id = d.id
  WHERE d.id = p_diamond_id AND d.status = 'listing'
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Diamond not in trading window', 'code', 'NOT_LISTING');
  END IF;
  
  v_window_end := v_diamond.ipo_closed_at + INTERVAL '30 days';
  IF NOW() > v_window_end THEN
    RETURN jsonb_build_object('success', false, 'error', 'Trading window closed', 'code', 'WINDOW_CLOSED', 'window_closed_at', v_window_end);
  END IF;
  
  IF p_side = 'buy' THEN
    v_total_cost := p_price * p_quantity;
    
    SELECT * INTO v_balance
    FROM user_balances
    WHERE user_id = p_user_id
    FOR UPDATE;
    
    IF NOT FOUND OR v_balance.balance < v_total_cost THEN
      RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance', 'code', 'INSUFFICIENT_FUNDS', 'required', v_total_cost, 'available', COALESCE(v_balance.balance, 0));
    END IF;
    
    UPDATE user_balances
    SET balance = balance - v_total_cost, reserved = COALESCE(reserved, 0) + v_total_cost, updated_at = NOW()
    WHERE user_id = p_user_id;
    
  ELSIF p_side = 'sell' THEN
    SELECT * INTO v_balance
    FROM gem_holdings
    WHERE user_id = p_user_id AND diamond_id = p_diamond_id
    FOR UPDATE;
    
    v_available := COALESCE(v_balance.quantity, 0);
    
    SELECT COALESCE(SUM(quantity - filled_quantity), 0) INTO v_pending_qty
    FROM orders
    WHERE user_id = p_user_id AND diamond_id = p_diamond_id AND side = 'sell' AND status IN ('open', 'partial');
    
    IF p_quantity > (v_available - v_pending_qty) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Insufficient PCUs', 'code', 'INSUFFICIENT_PCUS', 'available', v_available - v_pending_qty, 'requested', p_quantity);
    END IF;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Invalid side', 'code', 'INVALID_SIDE');
  END IF;
  
  INSERT INTO orders (diamond_id, user_id, side, order_type, price, quantity, filled_quantity, status, created_at, expires_at)
  VALUES (p_diamond_id, p_user_id, p_side, p_order_type, p_price, p_quantity, 0, 'open', NOW(), v_window_end)
  RETURNING id INTO v_order_id;
  
  RETURN jsonb_build_object('success', true, 'order_id', v_order_id, 'diamond_id', p_diamond_id, 'side', p_side, 'price', p_price, 'quantity', p_quantity, 'filled_quantity', 0, 'status', 'open', 'expires_at', v_window_end);
  
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'code', 'DATABASE_ERROR');
END;
$$;

CREATE OR REPLACE FUNCTION cancel_order_atomic(
  p_order_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_order RECORD;
  v_unfilled_value NUMERIC;
BEGIN
  SELECT * INTO v_order
  FROM orders
  WHERE id = p_order_id AND user_id = p_user_id AND status IN ('open', 'partial')
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found', 'code', 'ORDER_NOT_FOUND');
  END IF;
  
  IF v_order.side = 'buy' THEN
    v_unfilled_value := (v_order.quantity - v_order.filled_quantity) * v_order.price;
    
    UPDATE user_balances
    SET balance = balance + v_unfilled_value, reserved = GREATEST(0, reserved - v_unfilled_value), updated_at = NOW()
    WHERE user_id = p_user_id;
  END IF;
  
  UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = p_order_id;
  
  RETURN jsonb_build_object('success', true, 'order_id', p_order_id, 'message', 'Order cancelled', 'released_value', COALESCE(v_unfilled_value, 0));
  
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'code', 'DATABASE_ERROR');
END;
$$;

-- ============================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE diamonds ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE fills ENABLE ROW LEVEL SECURITY;
ALTER TABLE pcu_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_balances ENABLE ROW LEVEL SECURITY;

-- Profiles: Users can read all, update own
CREATE POLICY profiles_read ON profiles FOR SELECT USING (true);
CREATE POLICY profiles_update ON profiles FOR UPDATE USING (auth.uid() = id);

-- Diamonds: Public read, jeweler update own
CREATE POLICY diamonds_read ON diamonds FOR SELECT USING (true);
CREATE POLICY diamonds_update ON diamonds FOR UPDATE USING (auth.uid() = owner_id);

-- Orders: Users see own orders
CREATE POLICY orders_read ON orders FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY orders_insert ON orders FOR INSERT WITH CHECK (auth.uid() = user_id);

-- PCU Balances: Users see own
CREATE POLICY pcu_read ON pcu_balances FOR SELECT USING (auth.uid() = user_id OR wallet_address = auth.uid()::text);

-- User Balances: Users see own
CREATE POLICY user_balances_read ON user_balances FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY user_balances_update ON user_balances FOR UPDATE USING (auth.uid() = user_id);

-- ============================================
-- TRIGGERS
-- ============================================

-- Update timestamps
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER diamonds_updated_at BEFORE UPDATE ON diamonds
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER pcu_balances_updated_at BEFORE UPDATE ON pcu_balances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
