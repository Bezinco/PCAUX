// archive/bricks/brick-06-settlement.js
// PCAux Diamond Platform - Brick #6: Settlement & Redemption (Vercel/Supabase)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const REDEMPTION_WINDOW_DAYS = 7;
const CASH_PENALTY_BPS = 500;
const JEWELER_DELIVERY_FEE = 50;
const INSURANCE_FEE_BPS = 25;
const MINIMUM_REDEEM_PCUS = 101;

// ===== SINGLE REDEMPTION =====

export async function redeemDiamond(req, res) {
  const { diamondId } = req.params;
  const { delivery_address, delivery_method, insurance_required = true } = req.body;
  const userId = req.user.id;

  try {
    const { data: diamond } = await supabase
      .from('diamonds')
      .select(`
        *,
        graded_valuations!inner(graded_value),
        jewelers!inner(business_name, id as jeweler_id),
        ipos!inner(total_pcus)
      `)
      .eq('id', diamondId)
      .eq('status', 'resolved')
      .single();

    if (!diamond) {
      return res.status(404).json({ error: 'Diamond not available' });
    }

    const resolvedAt = new Date(diamond.resolved_at);
    const windowEnd = new Date(resolvedAt);
    windowEnd.setDate(windowEnd.getDate() + REDEMPTION_WINDOW_DAYS);

    if (new Date() > windowEnd) {
      return res.status(400).json({ error: 'Redemption window closed', closed_at: windowEnd });
    }

    const { data: holding } = await supabase
      .from('pcu_balances')
      .select('quantity')
      .eq('user_id', userId)
      .eq('diamond_id', diamondId)
      .single();

    if (!holding || holding.quantity < MINIMUM_REDEEM_PCUS) {
      return res.status(403).json({ 
        error: `Need ${MINIMUM_REDEEM_PCUS} PCUs, have ${holding?.quantity || 0}`,
        suggestion: 'Use combine-redeem for coalition redemption'
      });
    }

    const { data: existing } = await supabase
      .from('redemptions')
      .select('id')
      .eq('diamond_id', diamondId)
      .eq('user_id', userId)
      .in('status', ['pending', 'approved', 'in_transit'])
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Redemption already in progress' });
    }

    const diamondValue = diamond.graded_valuations.graded_value;
    const insuranceFee = insurance_required ? (diamondValue * (INSURANCE_FEE_BPS / 10000)) : 0;
    const deliveryFee = delivery_method === 'insured_shipment' ? JEWELER_DELIVERY_FEE : 0;

    const { data: redemption } = await supabase
      .from('redemptions')
      .insert({
        diamond_id: diamondId,
        user_id: userId,
        jeweler_id: diamond.jewelers.jeweler_id,
        pcu_quantity: holding.quantity,
        redemption_type: 'single',
        delivery_address,
        delivery_method,
        insurance_required,
        insurance_fee: insuranceFee,
        delivery_fee: deliveryFee,
        status: 'pending',
        requested_at: new Date().toISOString(),
        window_closes_at: windowEnd.toISOString()
      })
      .select()
      .single();

    await supabase
      .from('pcu_balances')
      .update({ reserved_for_redemption: true })
      .eq('user_id', userId)
      .eq('diamond_id', diamondId);

    return res.status(201).json({
      redemption_id: redemption.id,
      pcus_redeemed: holding.quantity,
      total_fees: insuranceFee + deliveryFee,
      window_closes_at: windowEnd
    });

  } catch (err) {
    return res.status(500).json({ error: 'Redemption request failed' });
  }
}

// ===== COALITION REDEMPTION =====

export async function createCoalition(req, res) {
  const { diamondId } = req.params;
  const { partners, designated_recipient, delivery_address, delivery_method, cash_distribution } = req.body;
  const userId = req.user.id;

  const allMembers = [userId, ...partners];
  const uniqueMembers = [...new Set(allMembers)];

  if (uniqueMembers.length < 2) {
    return res.status(400).json({ error: 'Coalition requires at least 2 unique members' });
  }

  try {
    const { data: holdings } = await supabase
      .from('pcu_balances')
      .select('user_id, quantity')
      .eq('diamond_id', diamondId)
      .in('user_id', uniqueMembers)
      .eq('reserved_for_redemption', false);

    if (holdings?.length !== uniqueMembers.length) {
      return res.status(400).json({ 
        error: 'Some members have no PCUs or already reserved',
        missing: uniqueMembers.filter(m => !holdings?.find(h => h.user_id === m))
      });
    }

    const totalPCUs = holdings.reduce((sum, h) => sum + h.quantity, 0);

    const { data: diamond } = await supabase
      .from('diamonds')
      .select('ipos(total_pcus)')
      .eq('id', diamondId)
      .single();

    const requiredPCUs = Math.ceil(diamond.ipos.total_pcus * 0.505);

    if (totalPCUs < requiredPCUs) {
      return res.status(400).json({ 
        error: `Need ${requiredPCUs} PCUs, coalition has ${totalPCUs}`,
        shortfall: requiredPCUs - totalPCUs
      });
    }

    if (!uniqueMembers.includes(designated_recipient)) {
      return res.status(400).json({ error: 'Designated recipient must be coalition member' });
    }

    const { data: coalition } = await supabase
      .from('redemption_coalitions')
      .insert({
        diamond_id: diamondId,
        total_pcus: totalPCUs,
        designated_recipient,
        delivery_address,
        delivery_method,
        cash_distribution_method: cash_distribution,
        status: 'forming',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    for (const member of uniqueMembers) {
      const memberHolding = holdings.find(h => h.user_id === member);
      await supabase.from('coalition_members').insert({
        coalition_id: coalition.id,
        user_id: member,
        pcu_contribution: memberHolding.quantity,
        status: 'pending_confirmation'
      });
    }

    await supabase
      .from('pcu_balances')
      .update({ reserved_for_redemption: true })
      .eq('diamond_id', diamondId)
      .in('user_id', uniqueMembers);

    return res.status(201).json({
      coalition_id: coalition.id,
      members: uniqueMembers.length,
      total_pcus: totalPCUs,
      designated_recipient,
      status: 'forming',
      message: 'All members must confirm within 24 hours'
    });

  } catch (err) {
    return res.status(500).json({ error: 'Coalition formation failed' });
  }
}

export async function confirmCoalition(req, res) {
  const { coalitionId } = req.params;
  const userId = req.user.id;

  try {
    const { data: member } = await supabase
      .from('coalition_members')
      .update({
        status: 'confirmed',
        confirmed_at: new Date().toISOString()
      })
      .eq('coalition_id', coalitionId)
      .eq('user_id', userId)
      .eq('status', 'pending_confirmation')
      .select()
      .single();

    if (!member) {
      return res.status(404).json({ error: 'Not a pending member of this coalition' });
    }

    const { data: status } = await supabase
      .from('coalition_members')
      .select('status')
      .eq('coalition_id', coalitionId);

    const allConfirmed = status?.every(m => m.status === 'confirmed');
    const total = status?.length || 0;
    const confirmed = status?.filter(m => m.status === 'confirmed').length || 0;

    if (allConfirmed) {
      await supabase
        .from('redemption_coalitions')
        .update({ status: 'active', activated_at: new Date().toISOString() })
        .eq('id
