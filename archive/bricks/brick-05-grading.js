// archive/bricks/brick-05-grading.js
// PCAux Diamond Platform - Brick #5: Grading Pipeline (Vercel/Supabase)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const GRADING_TIMES = {
  standard: { CGL: 14, GIA: 21 },
  rush: { CGL: 5, GIA: 7 }
};

const GRADE_MULTIPLIERS = {
  color: {
    'D': { 'D': 1.0, 'E': 0.85, 'F': 0.75, 'G': 0.65, 'H': 0.55, 'I': 0.45, 'J': 0.35 },
    'E': { 'D': 1.3, 'E': 1.0, 'F': 0.85, 'G': 0.75, 'H': 0.65, 'I': 0.55, 'J': 0.45 },
    'F': { 'D': 1.5, 'E': 1.2, 'F': 1.0, 'G': 0.85, 'H': 0.75, 'I': 0.65, 'J': 0.55 },
    'G': { 'D': 1.8, 'E': 1.4, 'F': 1.15, 'G': 1.0, 'H': 0.85, 'I': 0.75, 'J': 0.65 },
    'H': { 'D': 2.2, 'E': 1.7, 'F': 1.3, 'G': 1.15, 'H': 1.0, 'I': 0.85, 'J': 0.75 },
    'I': { 'D': 2.8, 'E': 2.1, 'F': 1.6, 'G': 1.3, 'H': 1.15, 'I': 1.0, 'J': 0.85 },
    'J': { 'D': 3.5, 'E': 2.6, 'F': 2.0, 'G': 1.6, 'H': 1.3, 'I': 1.15, 'J': 1.0 },
    'unknown': { 'D': 2.5, 'E': 2.0, 'F': 1.6, 'G': 1.3, 'H': 1.1, 'I': 0.9, 'J': 0.75 }
  },
  clarity: {
    'FL': { 'FL': 1.0, 'IF': 0.9, 'VVS1': 0.8, 'VVS2': 0.7, 'VS1': 0.6, 'VS2': 0.5 },
    'IF': { 'FL': 1.15, 'IF': 1.0, 'VVS1': 0.9, 'VVS2': 0.8, 'VS1': 0.7, 'VS2': 0.6 },
    'VVS1': { 'FL': 1.3, 'IF': 1.15, 'VVS1': 1.0, 'VVS2': 0.9, 'VS1': 0.8, 'VS2': 0.7 },
    'VVS2': { 'FL': 1.45, 'IF': 1.25, 'VVS1': 1.1, 'VVS2': 1.0, 'VS1': 0.9, 'VS2': 0.8 },
    'VS1': { 'FL': 1.65, 'IF': 1.4, 'VVS1': 1.25, 'VVS2': 1.1, 'VS1': 1.0, 'VS2': 0.9 },
    'VS2': { 'FL': 1.85, 'IF': 1.6, 'VVS1': 1.4, 'VVS2': 1.25, 'VS1': 1.1, 'VS2': 1.0 },
    'SI1': { 'FL': 2.2, 'IF': 1.9, 'VVS1': 1.65, 'VVS2': 1.45, 'VS1': 1.25, 'VS2': 1.1 },
    'SI2': { 'FL': 2.8, 'IF': 2.4, 'VVS1': 2.0, 'VVS2': 1.75, 'VS1': 1.5, 'VS2': 1.3 },
    'unknown': { 'FL': 2.0, 'IF': 1.7, 'VVS1': 1.5, 'VVS2': 1.3, 'VS1': 1.1, 'VS2': 1.0 }
  },
  cut: {
    'Ideal': { 'Ideal': 1.0, 'Excellent': 0.9, 'Very Good': 0.75, 'Good': 0.6 },
    'Excellent': { 'Ideal': 1.15, 'Excellent': 1.0, 'Very Good': 0.85, 'Good': 0.7 },
    'Very Good': { 'Ideal': 1.35, 'Excellent': 1.15, 'Very Good': 1.0, 'Good': 0.85 },
    'Good': { 'Ideal': 1.6, 'Excellent': 1.4, 'Very Good': 1.15, 'Good': 1.0 },
    'unknown': { 'Ideal': 1.3, 'Excellent': 1.15, 'Very Good': 1.0, 'Good': 0.85 }
  }
};

// ===== GRADING DASHBOARD =====

export async function getGradingQueue(req, res) {
  const { status = 'all' } = req.query;

  try {
    let query = supabase
      .from('grading_submissions')
      .select(`
        *,
        diamonds!inner(shape, estimated_carat, estimated_color, estimated_clarity, estimated_cut),
        graded_valuations!left(total_multiplier)
      `)
      .eq('diamonds.jeweler_id', req.jeweler.id)
      .order('submitted_at', { ascending: false });

    if (status !== 'all') {
      query = query.eq('status', status);
    }

    const { data: submissions } = await query;

    // Add timeline status
    const enriched = submissions?.map(row => {
      const expectedDays = row.grader === 'GIA' 
        ? (row.service_level === 'rush' ? GRADING_TIMES.rush.GIA : GRADING_TIMES.standard.GIA)
        : (row.service_level === 'rush' ? GRADING_TIMES.rush.CGL : GRADING_TIMES.standard.CGL);
      
      const daysAgo = (new Date() - new Date(row.submitted_at)) / (1000 * 60 * 60 * 24);
      
      return {
        ...row,
        days_ago: daysAgo,
        expected_days: expectedDays,
        timeline_status: row.completed_at 
          ? 'completed'
          : daysAgo > expectedDays * 1.5 
            ? 'overdue' 
            : daysAgo > expectedDays 
              ? 'at_risk' 
              : 'on_track',
        expected_completion: row.submitted_at 
          ? new Date(new Date(row.submitted_at).getTime() + expectedDays * 86400000).toISOString()
          : null
      };
    });

    return res.json({
      queue: enriched,
      summary: {
        total: enriched?.length || 0,
        pending: enriched?.filter(r => !r.completed_at).length || 0,
        completed: enriched?.filter(r => r.completed_at).length || 0,
        overdue: enriched?.filter(r => r.timeline_status === 'overdue').length || 0
      }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to load queue' });
  }
}

export async function getMultiplierConfidence(req, res) {
  const jewelerId = req.params.jewelerId || req.jeweler?.id;

  try {
    const { data: stats } = await supabase
      .from('graded_valuations')
      .select('total_multiplier')
      .eq('diamonds.jeweler_id', jewelerId)
      .gt('calculated_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString());

    if (!stats || stats.length === 0) {
      return res.json({ 
        message: 'Insufficient grading history',
        expected_range: '1.2x - 2.0x (platform average)'
      });
    }

    const multipliers = stats.map(s => s.total_multiplier);
    const avg = multipliers.reduce((a, b) => a + b, 0) / multipliers.length;
    const stddev = Math.sqrt(multipliers.reduce((sq, n) => sq + Math.pow(n - avg, 2), 0) / multipliers.length);

    return res.json({
      jeweler_id: jewelerId,
      sample_size: stats.length,
      statistics: {
        mean: avg.toFixed(2),
        stddev: stddev.toFixed(2),
        min: Math.min(...multipliers).toFixed(2),
        max: Math.max(...multipliers).toFixed(2)
      },
      confidence_intervals: {
        '68%': `${(avg - stddev).toFixed(2)}x - ${(avg + stddev).toFixed(2)}x`,
        '95%': `${(avg - 2 * stddev).toFixed(2)}x - ${(avg + 2 * stddev).toFixed(2)}x`
      }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to calculate confidence' });
  }
}

// ===== GRADING SUBMISSION =====

export async function submitForGrading(req, res) {
  const { diamondId } = req.params;
  const { grader, service_level = 'standard', origin_report = false, insurance_value } = req.body;

  try {
    // Verify diamond
    const { data: diamond } = await supabase
      .from('diamonds')
      .select(`
        *,
        ipos!inner(ipo_price, total_pcus, sold_pcus, id as ipo_id)
      `)
      .eq('id', diamondId)
      .eq('jeweler_id', req.jeweler.id)
      .in('status', ['listing', 'pending_grading'])
      .single();

    if (!diamond) {
      return res.status(404).json({ error: 'Diamond not found or not ready' });
    }

    if (diamond.ipos.sold_pcus < diamond.ipos.total_pcus * 0.5) {
      return res.status(400).json({ error: 'IPO must be at least 50% subscribed' });
    }

    const baseCost = grader === 'GIA' ? 250 : 150;
    const rushFee = service_level === 'rush' ? 100 : 0;
    const originFee = origin_report ? 75 : 0;
    const totalCost = baseCost + rushFee + originFee + 25;

    // Check treasury
    const { data: treasury } = await supabase
      .from('treasury_events')
      .select('amount, status')
      .eq('ipo_id', diamond.ipos.ipo_id);

    const locked = treasury?.filter(t => t.status === 'locked').reduce((sum, t) => sum + t.amount, 0) || 0;
    const spent = treasury?.filter(t => t.event_type === 'grading_paid').reduce((sum, t) => sum + t.amount, 0) || 0;
    const available = locked - spent;

    if (available < totalCost) {
      return res.status(402).json({ required: totalCost, available });
    }

    const expectedDays = service_level === 'rush' ? 7 : 21;

    // Create submission
    const { data: submission } = await supabase
      .from('grading_submissions')
      .insert({
        diamond_id: diamondId,
        ipo_id: diamond.ipos.ipo_id,
        grader,
        service_level,
        origin_report_requested: origin_report,
        cost: totalCost,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        expected_completion_at: new Date(Date.now() + expectedDays * 24 * 60 * 60 * 1000).toISOString()
      })
      .select()
      .single();

    // Record treasury event
    await supabase.from('treasury_events').insert({
      ipo_id: diamond.ipos.ipo_id,
      event_type: 'grading_paid',
      amount: totalCost,
      status: 'locked',
      metadata: { submission_id: submission.id, grader },
      created_at: new Date().toISOString()
    });

    // Update diamond
    await supabase
      .from('diamonds')
      .update({ status: 'grading', grader, grading_submitted_at: new Date().toISOString() })
      .eq('id', diamondId);

    // Update sleeve
    await supabase
      .from('sleeves')
      .update({ status: 'shipping_to_grader', current_diamond_id: null })
      .eq('id', diamond.sleeve_id);

    return res.json({
      submission_id: submission.id,
      grader,
      service_level,
      expected_days: expectedDays,
      expected_completion: submission.expected_completion_at,
      cost: totalCost,
      insurance_value: insurance_value || (diamond.ipos.total_pcus * diamond.ipos.ipo_price * 0.8)
    });

  } catch (err) {
    return res.status(500).json({ error: 'Submission failed' });
  }
}

// ===== GRADING RESULT =====

export async function recordGradingResult(req, res) {
  const {
    grader,
    submission_ref,
    certificate_number,
    report_url,
    results: {
      carat, color, clarity, cut, polish, symmetry, fluorescence,
      measurements, proportions, origin, comments
    }
  } = req.body;

  try {
    const { data: submission } = await supabase
      .from('grading_submissions')
      .select('*, diamonds!inner(*)')
      .eq('id', submission_ref)
      .eq('grader', grader)
      .single();

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (submission.status === 'completed') {
      return res.status(409).json({ error: 'Result already recorded' });
    }

    const diamond = submission.diamonds;

    // Update submission
    await supabase
      .from('grading_submissions')
      .update({
        status: 'completed',
        certificate_number,
        report_url,
        final_carat: carat,
        final_color: color,
        final_clarity: clarity,
        final_cut: cut,
        final_polish: polish,
        final_symmetry: symmetry,
        final_fluorescence: fluorescence,
        measurements,
        proportions,
        origin,
        comments,
        completed_at: new Date().toISOString()
      })
      .eq('id', submission_ref);

    // Update diamond
    await supabase
      .from('diamonds')
      .update({
        status: 'graded',
        final_carat: carat,
        final_color: color,
        final_clarity: clarity,
        final_cut: cut,
        final_polish: polish,
        final_symmetry: symmetry,
        final_fluorescence: fluorescence,
        final_certificate_url: report_url,
        grader,
        graded_at: new Date().toISOString()
      })
      .eq('id', submission.diamond_id);

    // Calculate multiplier
    const colorMult = GRADE_MULTIPLIERS.color[diamond.estimated_color || 'unknown']?.[color] || 1.0;
    const clarityMult = GRADE_MULTIPLIERS.clarity[diamond.estimated_clarity || 'unknown']?.[clarity] || 1.0;
    const cutMult = GRADE_MULTIPLIERS.cut[diamond.estimated_cut || 'unknown']?.[cut] || 1.0;
    const caratRatio = carat / diamond.estimated_carat;
    const caratMult = Math.pow(caratRatio, 1.5);

    const totalMultiplier = colorMult * clarityMult * cutMult * caratMult;
    const baseValue = diamond.ipos.total_pcus * diamond.ipos.ipo_price;
    const gradedValue = baseValue * totalMultiplier;

    // Record valuation
    await supabase.from('graded_valuations').insert({
      diamond_id: submission.diamond_id,
      submission_id: submission_ref,
      base_value: baseValue,
      graded_value: gradedValue,
      total_multiplier: totalMultiplier,
      color_mult: colorMult,
      clarity_mult: clarityMult,
      cut_mult: cutMult,
      carat_mult: caratMult,
      calculated_at: new Date().toISOString()
    });

    // Update jeweler score
    const gradeAccuracy = calculateAccuracy(diamond.estimated_color, color) +
                         calculateAccuracy(diamond.estimated_clarity, clarity) +
                         calculateAccuracy(diamond.estimated_cut, cut);

    await supabase
      .from('jewelers')
      .update({
        quality_king_score: Math.min(1000, (req.jeweler?.quality_king_score || 0) + Math.floor(gradeAccuracy * 10)),
        successful_sales: (req.jeweler?.successful_sales || 0) + 1,
        total_volume: (req.jeweler?.total_volume || 0) + gradedValue,
        updated_at: new Date().toISOString()
      })
      .eq('id', diamond.jeweler_id);

    // Schedule reveal
    await supabase.from('post_grade_events').insert({
      diamond_id: submission.diamond_id,
      event_type: 'reveal_scheduled',
      status: 'pending',
      scheduled_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    return res.json({
      received: true,
      diamond_id: submission.diamond_id,
      total_multiplier: totalMultiplier,
      graded_value: gradedValue
    });

  } catch (err) {
    return res.status(500).json({ error: 'Result processing failed' });
  }
}

function calculateAccuracy(estimated, actual) {
  if (!estimated || estimated === 'unknown') return 0.5;
  if (estimated === actual) return 1.0;
  
  const scales = {
    color: ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'],
    clarity: ['FL', 'IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2', 'I1', 'I2', 'I3'],
    cut: ['Ideal', 'Excellent', 'Very Good', 'Good', 'Fair', 'Poor']
  };
  
  let scale = scales.color;
  if (scales.clarity.includes(estimated)) scale = scales.clarity;
  else if (scales.cut.includes(estimated)) scale = scales.cut;
  
  const estIdx = scale.indexOf(estimated);
  const actIdx = scale.indexOf(actual);
  if (estIdx === -1 || actIdx === -1) return 0.5;
  
  return Math.max(0, 1 - (Math.abs(estIdx - actIdx) * 0.2));
}

// ===== GRADE REVEAL =====

export async function getGrade(req, res) {
  const { diamondId } = req.params;

  try {
    const { data: result } = await supabase
      .from('diamonds')
      .select(`
        *,
        graded_valuations!inner(*),
        grading_submissions!left(certificate_number, report_url, origin as final_origin, completed_at as graded_at),
        jewelers!inner(quality_king_score as jeweler_score)
      `)
      .eq('id', diamondId)
      .in('status', ['graded', 'resolved', 'fully_redeemed'])
      .single();

    if (!result) return res.status(404).json({ error: 'Grade not available' });

    return res.json({
      certificate: {
        number: result.grading_submissions?.certificate_number,
        url: result.final_certificate_url,
        grader: result.grader,
        date: result.grading_submissions?.graded_at
      },
      final_grades: {
        carat: result.final_carat,
        color: result.final_color,
        clarity: result.final_clarity,
        cut: result.final_cut,
        polish: result.final_polish,
        symmetry: result.final_symmetry,
        fluorescence: result.final_fluorescence,
        origin: result.grading_submissions?.final_origin
      },
      estimates: {
        carat: result.estimated_carat,
        color: result.estimated_color,
        clarity: result.estimated_clarity,
        cut: result.estimated_cut
      },
      valuation: {
        base_value: result.graded_valuations?.base_value,
        graded_value: result.graded_valuations?.graded_value,
        total_multiplier: result.graded_valuations?.total_multiplier
      },
      jeweler_reliability: result.jeweler_score > 800 ? 'high' : result.jeweler_score > 500 ? 'medium' : 'developing'
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to load grade' });
  }
}

export async function revealGrade(req, res) {
  const { diamondId } = req.params;

  try {
    const { data: diamond } = await supabase
      .from('diamonds')
      .select('*')
      .eq('id', diamondId)
      .eq('status', 'graded')
      .single();

    if (!diamond) {
      return res.status(404).json({ error: 'Not ready for reveal' });
    }

    await supabase
      .from('diamonds')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('id', diamondId);

    await supabase
      .from('orders')
      .update({ status: 'expired' })
      .eq('diamond_id', diamondId)
      .in('status', ['open', 'partial']);

    await supabase.from('post_grade_markets').insert({
      diamond_id: diamondId,
      status: 'active',
      opened_at: new Date().toISOString()
    });

    return res.json({ diamond_id: diamondId, status: 'resolved', message: 'Grade revealed. Post-grade trading open.' });

  } catch (err) {
    return res.status(500).json({ error: 'Reveal failed' });
  }
}

// ===== INSURANCE CLAIMS =====

export async function submitGradingClaim(req, res) {
  const { submissionId } = req.params;
  const { claim_type, description, evidence_urls } = req.body;

  try {
    const { data: submission } = await supabase
      .from('grading_submissions')
      .select('*, diamonds!inner(jeweler_id, insurance_value)')
      .eq('id', submissionId)
      .single();

    if (!submission || submission.diamonds.jeweler_id !== req.jeweler.id) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const { data: claim } = await supabase
      .from('grading_insurance_claims')
      .insert({
        submission_id: submissionId,
        diamond_id: submission.diamond_id,
        jeweler_id: req.jeweler.id,
        claim_type,
        description,
        evidence_urls,
        claimed_amount: submission.diamonds.insurance_value || 0,
        status: 'pending',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    return res.status(201).json({
      claim_id: claim.id,
      claimed_amount: claim.claimed_amount,
      status: 'pending',
      message: 'Claim submitted. Review within 5 business days.'
    });

  } catch (err) {
    return res.status(500).json({ error: 'Claim submission failed' });
  }
}

// ===== ADMIN QUERIES =====

export async function getAdminGradingQueue(req, res) {
  const { status = 'all', grader, overdue_only = false } = req.query;

  try {
    let query = supabase
      .from('grading_submissions')
      .select(`
        *,
        diamonds!inner(estimated_carat, shape, jeweler_id),
        jewelers!inner(business_name)
      `)
      .order('submitted_at');

    if (status !== 'all') query = query.eq('status', status);
    if (grader) query = query.eq('grader', grader);
    if (overdue_only === 'true') {
      query = query.lt('expected_completion_at', new Date().toISOString()).eq('status', 'submitted');
    }

    const { data: rows } = await query;

    const enriched = rows?.map(r => ({
      ...r,
      days_in_queue: (new Date() - new Date(r.submitted_at)) / (1000 * 60 * 60 * 24),
      timeline_status: r.expected_completion_at < new Date().toISOString() ? 'overdue' :
                       new Date(r.expected_completion_at) < new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) ? 'at_risk' : 'on_track'
    }));

    return res.json({
      queue: enriched,
      summary: {
        total: enriched?.length || 0,
        overdue: enriched?.filter(r => r.timeline_status === 'overdue').length || 0,
        at_risk: enriched?.filter(r => r.timeline_status === 'at_risk').length || 0
      }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to load queue' });
  }
}
