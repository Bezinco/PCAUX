// archive/bricks/brick-03-ipo.js
// PCAux Diamond Platform - Brick #3: IPO Engine (Vercel/Supabase)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const IPO_DURATION_HOURS = 48;
const MIN_IPO_PRICE = 25;
const MAX_IPO_PRICE = 100;
const DEFAULT_TOTAL_PCUS = 200;
const PER_WALLET_CAP_PERCENT = 10;

// ===== PRICE DISCOVERY =====

async function calculateOptimalPrice(diamondId, estimated_carat, estimated_color, estimated_clarity) {
  const { data: similar } = await supabase
    .from('ipos')
    .select('ipo_price')
    .eq('status', 'closed')
    .gt('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
    .filter('diamonds.estimated_carat', 'gte', estimated_carat * 0.9)
    .filter('diamonds.estimated_carat', 'lte', estimated_carat * 1.1)
    .eq('diamonds.estimated_color', estimated_color)
    .eq('diamonds.estimated_clarity', estimated_clarity)
    .limit(10);

  if (!similar || similar.length < 3) {
    return Math.max(MIN_IPO_PRICE, estimated_carat * 50);
  }

  const prices = similar.map(s => s.ipo_price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  
  return Math.min(MAX_IPO_PRICE, Math.max(MIN_IPO_PRICE, median));
}

// ===== IPO CREATION =====

export async function createIPO(req, res) {
  const { diamondId } = req.params;
  const { 
    ipo_price, 
    total_pcus = DEFAULT_TOTAL_PCUS, 
    duration_hours = IPO_DURATION_HOURS,
    use_dynamic_pricing = true 
  } = req.body;

  try {
    // Verify diamond
    const { data: diamond } = await supabase
      .from('diamonds')
      .select('estimated_carat, estimated_color, estimated_clarity, estimated_cut, shape')
      .eq('id', diamondId)
      .eq('jeweler_id', req.jeweler.id)
      .eq('status', 'verified')
      .single();

    if (!diamond) {
      return res.status(404).json({ error: 'Diamond not found or not verified' });
    }

    // Check existing IPO
    const { data: existing } = await supabase
      .from('ipos')
      .select('id')
      .eq('diamond_id', diamondId)
      .in('status', ['open', 'pending'])
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Active IPO already exists' });
    }

    // Determine price
    let finalPrice = ipo_price;
    if (use_dynamic_pricing || !ipo_price) {
      finalPrice = await calculateOptimalPrice(
        diamondId, 
        diamond.estimated_carat, 
        diamond.estimated_color, 
        diamond.estimated_clarity
      );
    }

    const total_value = finalPrice * total_pcus;
    const closes_at = new Date(Date.now() + duration_hours * 60 * 60 * 1000).toISOString();

    // Create IPO
    const { data: ipo, error } = await supabase
      .from('ipos')
      .insert({
        diamond_id: diamondId,
        jeweler_id: req.jeweler.id,
        ipo_price: finalPrice,
        total_pcus,
        sold_pcus: 0,
        total_value,
        status: 'open',
        opens_at: new Date().toISOString(),
        closes_at,
        duration_hours,
        pricing_method: use_dynamic_pricing ? 'dynamic' : 'manual',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    // Update diamond status
    await supabase
      .from('diamonds')
      .update({ status: 'listing', updated_at: new Date().toISOString() })
      .eq('id', diamondId);

    // Log metrics
    await supabase.from('ipo_creation_metrics').insert({
      ipo_id: ipo.id,
      suggested_price: ipo_price || null,
      final_price: finalPrice,
      confidence_score: use_dynamic_pricing ? 0.8 : 1.0,
      created_at: new Date().toISOString()
    });

    return res.status(201).json({
      ipo_id: ipo.id,
      diamond_id: diamondId,
      ipo_price: finalPrice,
      total_pcus,
      total_value,
      closes_at,
      pricing_method: use_dynamic_pricing ? 'dynamic' : 'manual',
      per_wallet_cap: Math.floor(total_pcus * (PER_WALLET_CAP_PERCENT / 100)),
      message: 'IPO live. Auto-close scheduled.'
    });

  } catch (err) {
    console.error('IPO creation error:', err);
    return res.status(500).json({ error: 'IPO creation failed' });
  }
}

// ===== IPO SUBSCRIPTION =====

export async function subscribeToIPO(req, res) {
  const { ipoId } = req.params;
  const { quantity } = req.body;

  try {
    // Get IPO
    const { data: ipo } = await supabase
      .from('ipos')
      .select('*, diamonds!inner(jeweler_id), jewelers!inner(business_name as jeweler_name)')
      .eq('id', ipoId)
      .eq('status', 'open')
      .single();

    if (!ipo) return res.status(404).json({ error: 'IPO not found or closed' });

    const totalCost = quantity * ipo.ipo_price;

    // Check user balance
    const { data: balance } = await supabase
      .from('user_balances')
      .select('balance')
      .eq('user_id', req.user.id)
      .single();

    if (!balance || balance.balance < totalCost) {
      return res.status(402).json({
        error: 'Insufficient balance',
        required: totalCost,
        available: balance?.balance || 0
      });
    }

    // Check cap
    const { data: held } = await supabase
      .from('ipo_subscriptions')
      .select('quantity')
      .eq('ipo_id', ipoId)
      .eq('user_id', req.user.id);

    const totalHeld = held?.reduce((sum, h) => sum + h.quantity, 0) || 0;
    const maxCap = Math.floor(ipo.total_pcus * ((PER_WALLET_CAP_PERCENT + 15) / 100));

    if (totalHeld + quantity > maxCap) {
      return res.status(400).json({ error: 'Cap exceeded', max: maxCap, held: totalHeld });
    }

    // Record subscription
    await supabase.from('ipo_subscriptions').insert({
      ipo_id: ipoId,
      user_id: req.user.id,
      quantity,
      price_per_pcu: ipo.ipo_price,
      total_cost: totalCost,
      status: 'confirmed',
      created_at: new Date().toISOString()
    });

    // Update IPO
    const newSold = ipo.sold_pcus + quantity;
    const newStatus = newSold >= ipo.total_pcus ? 'closed' : 'open';

    await supabase
      .from('ipos')
      .update({ sold_pcus: newSold, status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', ipoId);

    // Deduct balance
    await supabase
      .from('user_balances')
      .update({ balance: balance.balance - totalCost, updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id);

    // Mint PCUs
    await supabase.from('pcu_balances').upsert({
      user_id: req.user.id,
      diamond_id: ipo.diamond_id,
      ipo_id: ipoId,
      quantity,
      acquired_at: new Date().toISOString()
    }, { onConflict: 'user_id,diamond_id' });

    return res.json({ success: true, pcus_minted: quantity });

  } catch (err) {
    return res.status(500).json({ error: 'Subscription failed' });
  }
}

// ===== PCU TRANSFERS =====

export async function transferPCUs(req, res) {
  const { diamond_id, quantity, to_user_id, price_per_pcu } = req.body;
  const from_user_id = req.user.id;

  if (from_user_id === to_user_id) {
    return res.status(400).json({ error: 'Cannot transfer to self' });
  }

  try {
    // Verify sender has PCUs
    const { data: sender } = await supabase
      .from('pcu_balances')
      .select('quantity')
      .eq('user_id', from_user_id)
      .eq('diamond_id', diamond_id)
      .single();

    if (!sender || sender.quantity < quantity) {
      return res.status(400).json({ error: 'Insufficient PCUs' });
    }

    // Verify recipient
    const { data: recipient } = await supabase
      .from('users')
      .select('id')
      .eq('id', to_user_id)
      .eq('status', 'active')
      .single();

    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    // Execute transfer
    await supabase
      .from('pcu_balances')
      .update({ quantity: sender.quantity - quantity, updated_at: new Date().toISOString() })
      .eq('user_id', from_user_id)
      .eq('diamond_id', diamond_id);

    await supabase.from('pcu_balances').upsert({
      user_id: to_user_id,
      diamond_id,
      quantity,
      acquired_at: new Date().toISOString()
    }, { onConflict: 'user_id,diamond_id' });

    // Record transfer
    await supabase.from('pcu_transfers').insert({
      diamond_id,
      from_user_id,
      to_user_id,
      quantity,
      price_per_pcu,
      total_value: quantity * price_per_pcu,
      created_at: new Date().toISOString()
    });

    return res.json({ 
      success: true, 
      transferred: quantity, 
      diamond_id, 
      to_user_id,
      price_per_pcu
    });

  } catch (err) {
    return res.status(500).json({ error: 'Transfer failed' });
  }
}

// ===== QUERIES =====

export async function getIPO(req, res) {
  const { ipoId } = req.params;

  try {
    const { data: ipo } = await supabase
      .from('ipos')
      .select(`
        *,
        diamonds!inner(estimated_carat, estimated_color, estimated_clarity, estimated_cut, shape, images, jeweler_id),
        jewelers!inner(business_name as jeweler_name, quality_king_tier as jeweler_tier)
      `)
      .eq('id', ipoId)
      .single();

    if (!ipo) return res.status(404).json({ error: 'IPO not found' });

    // Calculate seconds remaining
    const secondsRemaining = Math.max(0, new Date(ipo.closes_at) - new Date()) / 1000;
    
    return res.json({
      ...ipo,
      seconds_remaining: secondsRemaining,
      status: secondsRemaining <= 0 && ipo.status === 'open' ? 'closed' : ipo.status
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to load IPO' });
  }
}

export async function listIPOs(req, res) {
  const { status = 'open', jeweler_id, limit = 20, offset = 0 } = req.query;

  try {
    let query = supabase
      .from('ipos')
      .select(`
        id, ipo_price, total_pcus, sold_pcus, status,
        opens_at, closes_at, pricing_method,
        diamonds!inner(id as diamond_id, estimated_carat, estimated_color, estimated_clarity, shape, images),
        jewelers!inner(business_name as jeweler_name, quality_king_tier as jeweler_tier)
      `)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(limit)
      .range(offset, offset + limit - 1);

    if (jeweler_id) {
      query = query.eq('jeweler_id', jeweler_id);
    }

    const { data: ipos } = await query;

    // Parse images and calculate remaining time
    ipos?.forEach(ipo => {
      if (ipo.diamonds?.images) {
        ipo.diamonds.images = JSON.parse(ipo.diamonds.images);
      }
      const secondsRemaining = Math.max(0, new Date(ipo.closes_at) - new Date()) / 1000;
      if (secondsRemaining <= 0 && ipo.status === 'open') {
        ipo.status = 'closed';
      }
      ipo.seconds_remaining = secondsRemaining;
    });

    return res.json({ ipos, limit, offset });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load IPOs' });
  }
}

export async function getIPOAnalytics(req, res) {
  const { days = 30 } = req.query;

  try {
    const { data: summary } = await supabase
      .from('ipos')
      .select(`
        count,
        status,
        total_value,
        sold_pcus,
        total_pcus
      `)
      .gt('created_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
      .eq('jeweler_id', req.jeweler.id);

    const total = summary?.length || 0;
    const successful = summary?.filter(i => i.status === 'closed').length || 0;
    const failed = summary?.filter(i => i.status === 'failed').length || 0;
    const avgFillRate = summary?.filter(i => i.status === 'closed')
      .reduce((sum, i) => sum + (i.sold_pcus / i.total_pcus), 0) / successful || 0;

    return res.json({
      summary: {
        total_ipos: total,
        successful_ipos: successful,
        failed_ipos: failed,
        avg_fill_rate: avgFillRate
      },
      period_days: days
    });

  } catch (err) {
    return res.status(500).json({ error: 'Analytics failed' });
  }
}
