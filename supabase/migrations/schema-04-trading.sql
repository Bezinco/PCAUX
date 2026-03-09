-- schema-04-trading.sql
-- PCAux Diamond Platform - Schema for Brick #4: Pre-Grade Trading Market

-- Orders (limit orders in the book)
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    user_id UUID NOT NULL REFERENCES users(id),
    side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
    order_type VARCHAR(10) DEFAULT 'limit' CHECK (order_type IN ('limit', 'ioc', 'fok')),
    price DECIMAL(12, 2) NOT NULL,
    quantity INTEGER NOT NULL,
    filled_quantity INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'partial', 'filled', 'cancelled', 'expired')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Fills (executed trades)
CREATE TABLE fills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buy_order_id UUID NOT NULL REFERENCES orders(id),
    sell_order_id UUID NOT NULL REFERENCES orders(id),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    price DECIMAL(12, 2) NOT NULL,
    quantity INTEGER NOT NULL,
    buyer_fee DECIMAL(12, 2) NOT NULL, -- taker fee
    seller_fee DECIMAL(12, 2) NOT NULL, -- maker fee
    created_at TIMESTAMP DEFAULT NOW()
);

-- Trading fees collected
CREATE TABLE trading_fees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fill_id UUID NOT NULL REFERENCES fills(id),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    fee_type VARCHAR(10) NOT NULL CHECK (fee_type IN ('maker', 'taker', 'platform')),
    amount DECIMAL(12, 2) NOT NULL,
    collected_at TIMESTAMP DEFAULT NOW()
);

-- Price history (for candles)
CREATE TABLE price_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    diamond_id UUID NOT NULL REFERENCES diamonds(id),
    interval VARCHAR(10) NOT NULL, -- '1m', '5m', '1h', '1d'
    time_bucket TIMESTAMP NOT NULL,
    open DECIMAL(12, 2) NOT NULL,
    high DECIMAL(12, 2) NOT NULL,
    low DECIMAL(12, 2) NOT NULL,
    close DECIMAL(12, 2) NOT NULL,
    volume INTEGER NOT NULL,
    UNIQUE(diamond_id, interval, time_bucket)
);

-- Indexes
CREATE INDEX idx_orders_diamond ON orders(diamond_id);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_side_price ON orders(diamond_id, side, price) WHERE status IN ('open', 'partial');
CREATE INDEX idx_fills_diamond ON fills(diamond_id);
CREATE INDEX idx_fills_buy_order ON fills(buy_order_id);
CREATE INDEX idx_fills_sell_order ON fills(sell_order_id);
CREATE INDEX idx_fills_time ON fills(created_at);
CREATE INDEX idx_price_history_lookup ON price_history(diamond_id, interval, time_bucket);

-- Triggers
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
