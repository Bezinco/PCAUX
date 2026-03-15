// archive/bricks/brick-08-admin.js
// PCAux Diamond Platform - Brick #8: Admin Dashboard (Vercel/Supabase)

import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ===== ADMIN AUTH =====

export async function adminLogin(req, res) {
  const { email, password } = req.body;

  try {
    const { data: admin } = await supabase
      .from('admins')
      .select('*')
      .eq('email', email)
      .eq('active', true)
      .single();

    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const { data: authData, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

    return res.json({ 
      token: authData.session.access_token, 
      role: admin.role, 
      expiresIn: '8h' 
    });

  } catch (err) {
    return res.status(500).json({ error: 'Login failed' });
  }
}

// ===== DASHBOARD =====

export async function getDashboard(req, res) {
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [
      { data: jewelers },
      { data: diamonds },
      { data: ipos },
      { data: trades },
      { data: gradings },
      { data: redemptions }
    ] = await Promise.all([
      supabase.from('jewelers').select('count, status'),
      supabase.from('diamonds').select('count, status'),
      supabase.from('ipos').select('count, status, total_value, sold_pcus, total_pcus').gt('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
      supabase.from('fills').select('count, quantity, price, buyer_fee, seller_fee').gt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      supabase.from('grading_submissions').select('count, status, final_carat, estimated_carat, estimated_color, final_color').gt('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
      supabase.from('redemptions').select('count, status, settlement_type, net_value').gt('requested_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    ]);

    const activeJewelers = jewelers?.filter(j => j.status === 'active').length || 0;
    const totalDiamonds = diamonds?.length || 0;
    const listingDiamonds = diamonds?.filter(d => d.status === 'listing').length || 0;
    
    const closedIPOs = ipos?.filter(i => i.status === 'closed') || [];
    const totalRaised = closedIPOs.reduce((sum, i) => sum + (i.total_value || 0), 0);
    const avgFillRate = closedIPOs.length ? closedIPOs.reduce((sum, i) => sum + (i.sold_pcus / i.total_pcus), 0) / closedIPOs.length : 0;

    return res.json({
      date: today,
      jewelers: { total: jewelers?.length, active: activeJewelers },
      diamonds: { total: totalDiamonds, listing: listingDiamonds },
      ipos: { 
        total: ipos?.length, 
        closed: closedIPOs.length,
        total_raised: totalRaised,
        avg_fill_rate: avgFillRate
      },
      trades: {
        total_fills_24h: trades?.length,
        total_volume: trades?.reduce((sum, t) => sum + ((t.price || 0) * (t.quantity || 0)), 0)
      },
      gradings: {
        total: gradings?.length,
        completed: gradings?.filter(g => g.status === 'completed').length
      },
      redemptions: {
        total: redemptions?.length,
        delivered: redemptions?.filter(r => r.status === 'delivered').length
      },
      platform_health: {
        total: Math.round((activeJewelers / 10 * 25) + (listingDiamonds / 20 * 25) + (avgFillRate * 25) + (Math.min(totalRaised / 100000, 1) * 25))
      }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Dashboard load failed' });
  }
}

// ===== DIAMOND MANAGEMENT =====

export async function listAdminDiamonds(req, res) {
  const { status, jeweler_id, grader, limit = 50, offset = 0 } = req.query;

  try {
    let query = supabase
      .from('diamonds')
      .select(`
        *,
        jewelers!inner(business_name as jeweler_name, quality_king_tier as jeweler_tier),
        ipos!left(ipo_price, total_pcus, sold_pcus, status as ipo_status),
        graded_valuations!left(total_multiplier, graded_value)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (jeweler_id) query = query.eq('jeweler_id', jeweler_id);
    if (grader) query = query.eq('grader', grader);

    const { data: diamonds } = await query;

    return res.json({ diamonds, limit, offset });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load diamonds' });
  }
}

export async function getDiamondDetails(req, res) {
  const { diamondId } = req.params;

  try {
    const { data: diamond } = await supabase
      .from('diamonds')
      .select(`
        *,
        jewelers!inner(business_name, email as jeweler_email, quality_king_score),
        sleeve_verifications!left(*),
        ipo_subscriptions!left(*, users!inner(display_name, email)),
        orders!left(*),
        fills!left(*),
        redemptions!left(*),
        grading_accuracy_logs!left(*)
      `)
      .eq('id', diamondId)
      .single();

    if (!diamond) return res.status(404).json({ error: 'Diamond not found' });

    return res.json({
      diamond,
      audit_trail: {
        verifications: diamond.sleeve_verifications,
        subscriptions: diamond.ipo_subscriptions,
        orders: diamond.orders,
        fills: diamond.fills,
        redemptions: diamond.redemptions
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load diamond details' });
  }
}

export async function update4C(req, res) {
  const { diamondId } = req.params;
  const { field, value, reason } = req.body;

  try {
    const { data: oldDiamond } = await supabase
      .from('diamonds')
      .select(field)
      .eq('id', diamondId)
      .single();

    // Log change
    await supabase.from('diamond_4c_changes').insert({
      diamond_id: diamondId,
      field,
      old_value: oldDiamond[field],
      new_value: value,
      reason,
      admin_id: req.user.id,
      changed_at: new Date().toISOString()
    });

    // Apply change
    await supabase
      .from('diamonds')
      .update({ [field]: value, updated_at: new Date().toISOString() })
      .eq('id', diamondId);

    return res.json({ message: '4C data updated', field, value, reason });
  } catch (err) {
    return res.status(500).json({ error: 'Update failed' });
  }
}

// ===== GRADER API MANAGEMENT =====

export async function listGraderAPIs(req, res) {
  try {
    const { data: graders } = await supabase
      .from('grader_apis')
      .select(`
        *,
        grading_submissions!left(count),
        grading_submissions!left(completed_at, submitted_at)
      `);

    return res.json({ graders });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load grader APIs' });
  }
}

export async function updateGraderAPI(req, res) {
  const { graderId } = req.params;
  const updates = req.body;

  const allowed = ['api_endpoint', 'api_key', 'active', 'cost_standard', 'cost_rush', 'avg_turnaround_days', 'notes'];
  const fields = {};
  
  Object.keys(updates).forEach(key => {
    if (allowed.includes(key)) fields[key] = updates[key];
  });

  try {
    const { data: grader } = await supabase
      .from('grader_apis')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', graderId)
      .select()
      .single();

    return res.json({ grader });
  } catch (err) {
    return res.status(500).json({ error: 'Update failed' });
  }
}

// ===== DISPUTE RESOLUTION =====

export async function listDisputes(req, res) {
  const { status = 'open', limit = 20, offset = 0 } = req.query;

  try {
    const { data: disputes } = await supabase
      .from('disputes')
      .select(`
        *,
        users!inner(display_name as user_name, email as user_email),
        jewelers!inner(business_name as jeweler_name),
        diamonds!inner(estimated_carat, final_carat),
        graded_valuations!left(total_multiplier)
      `)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    return res.json({ disputes });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load disputes' });
  }
}

export async function resolveDispute(req, res) {
  const { disputeId } = req.params;
  const { resolution, refund_amount, notes } = req.body;

  try {
    const { data: dispute } = await supabase
      .from('disputes')
      .select('user_id, jeweler_id')
      .eq('id', disputeId)
      .single();

    // Update dispute
    await supabase
      .from('disputes')
      .update({
        status: 'resolved',
        resolution,
        refund_amount: refund_amount || 0,
        resolved_by: req.user.id,
        resolution_notes: notes,
        resolved_at: new Date().toISOString()
      })
      .eq('id', disputeId);

    // Process refund
    if (resolution === 'refund' && refund_amount > 0) {
      await supabase.from('user_balances').upsert({
        user_id: dispute.user_id,
        balance: refund_amount,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
    }

    // Penalize jeweler if they lost
    if (resolution === 'user_favor') {
      await supabase
        .from('jewelers')
        .update({ 
          quality_king_score: Math.max(0, supabase.raw('quality_king_score - 50')),
          updated_at: new Date().toISOString()
        })
        .eq('id', dispute.jeweler_id);
    }

    return res.json({ message: 'Dispute resolved', resolution, refund_amount });
  } catch (err) {
    return res.status(500).json({ error: 'Resolution failed' });
  }
}

// ===== KYB MANAGEMENT =====

export async function listPendingKYB(req, res) {
  try {
    const { data: verifications } = await supabase
      .from('kyb_verifications')
      .select(`
        *,
        jewelers!inner(business_name, email, tax_id, created_at as registered_at)
      `)
      .eq('status', 'pending')
      .order('created_at');

    return res.json({ verifications });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load verifications' });
  }
}

export async function reviewKYB(req, res) {
  const { kybId } = req.params;
  const { decision, notes } = req.body;

  try {
    const { data: kyb } = await supabase
      .from('kyb_verifications')
      .select('jeweler_id')
      .eq('id', kybId)
      .single();

    const newStatus = decision === 'approve' ? 'verified' : 'rejected';
    const jewelerStatus = decision === 'approve' ? 'active' : 'rejected';

    await supabase
      .from('kyb_verifications')
      .update({
        status: newStatus,
        reviewer_notes: notes,
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', kybId);

    await supabase
      .from('jewelers')
      .update({
        kyb_status: newStatus,
        status: jewelerStatus,
        kyb_verified_at: decision === 'approve' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      })
      .eq('id', kyb.jeweler_id);

    return res.json({ message: `Jeweler KYB ${decision}d`, jeweler_id: kyb.jeweler_id });
  } catch (err) {
    return res.status(500).json({ error: 'Review failed' });
  }
}

// ===== ADMIN MANAGEMENT =====

export async function createAdmin(req, res) {
  const { email, password, role, name } = req.body;
  const hash = await bcrypt.hash(password, 12);

  try {
    const { data: admin } = await supabase
      .from('admins')
      .insert({
        email,
        password_hash: hash,
        role,
        name,
        active: true,
        created_at: new Date().toISOString()
      })
      .select('id, email, role, name, created_at')
      .single();

    return res.status(201).json(admin);
  } catch (err) {
    return res.status(409).json({ error: 'Email already exists' });
  }
}
