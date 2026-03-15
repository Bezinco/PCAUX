// archive/bricks/brick-01-auth.js
// PCAux Diamond Platform - Brick #1: Auth & Jeweler Onboarding (Vercel/Supabase)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const JWT_EXPIRY = '8h';

// ===== USER REGISTRATION =====

export async function register(req, res) {
  const { email, password, display_name } = req.body;

  try {
    // Check existing
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Registration failed' });
    }

    // Create auth user
    const { data: authUser, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) throw authError;

    // Create user profile
    const { data: user, error: profileError } = await supabase
      .from('users')
      .insert({
        id: authUser.user.id,
        email,
        display_name,
        role: 'speculator',
        status: 'active',
        created_at: new Date().toISOString(),
        kyc_status: 'pending',
        email_verified: false
      })
      .select()
      .single();

    if (profileError) throw profileError;

    // Create verification token
    const verifyToken = crypto.randomUUID();
    await supabase.from('email_verifications').insert({
      user_id: user.id,
      token_hash: verifyToken,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    return res.status(201).json({
      user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role },
      requires_email_verification: true
    });

  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
}

// ===== USER LOGIN =====

export async function login(req, res) {
  const { email, password, mfa_token } = req.body;

  try {
    // Sign in with Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (authError) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Get user profile
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('id', authData.user.id)
      .single();

    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'Account inactive' });
    }

    // Check MFA if enabled
    if (user.mfa_enabled && !mfa_token) {
      return res.json({ 
        requires_mfa: true,
        mfa_token: crypto.randomUUID()
      });
    }

    // Update last login
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);

    // Create session
    const { data: session } = await supabase
      .from('user_sessions')
      .insert({
        user_id: user.id,
        token_jti: authData.session.access_token,
        ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        user_agent: req.headers['user-agent'],
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      })
      .select()
      .single();

    return res.json({
      token: authData.session.access_token,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        kyc_status: user.kyc_status,
        quality_king_tier: user.quality_king_tier || 'novice',
        email_verified: user.email_verified,
        mfa_enabled: user.mfa_enabled
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
}

// ===== EMAIL VERIFICATION =====

export async function verifyEmail(req, res) {
  const { token } = req.query;

  try {
    const { data: verification } = await supabase
      .from('email_verifications')
      .select('*, users!inner(email)')
      .eq('token_hash', token)
      .gt('expires_at', new Date().toISOString())
      .is('verified_at', null)
      .single();

    if (!verification) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    // Update user
    await supabase
      .from('users')
      .update({ email_verified: true, updated_at: new Date().toISOString() })
      .eq('id', verification.user_id);

    // Mark verification complete
    await supabase
      .from('email_verifications')
      .update({ verified_at: new Date().toISOString() })
      .eq('id', verification.id);

    return res.json({ message: 'Email verified successfully' });

  } catch (err) {
    return res.status(500).json({ error: 'Verification failed' });
  }
}

// ===== LOGOUT =====

export async function logout(req, res) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }

  const token = auth.split(' ')[1];

  try {
    await supabase
      .from('user_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('token_jti', token);

    return res.json({ message: 'Logged out successfully' });

  } catch (err) {
    return res.status(500).json({ error: 'Logout failed' });
  }
}

// ===== MIDDLEWARE HELPERS =====

export async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const token = auth.split(' ')[1];
    
    // Verify with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Check session
    const { data: session } = await supabase
      .from('user_sessions')
      .select('*')
      .eq('token_jti', token)
      .gt('expires_at', new Date().toISOString())
      .is('revoked_at', null)
      .single();

    if (!session) {
      return res.status(401).json({ error: 'Session expired or revoked' });
    }

    // Get full user profile
    const { data: profile } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    req.user = profile;
    req.tokenJti = token;
    next();

  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export async function requireJeweler(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }

  try {
    const token = auth.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get jeweler profile
    const { data: jeweler } = await supabase
      .from('jewelers')
      .select('*')
      .eq('id', user.id)
      .single();

    if (!jeweler || jeweler.status !== 'active') {
      return res.status(401).json({ error: 'Jeweler account inactive' });
    }

    if (jeweler.kyb_status !== 'verified') {
      return res.status(403).json({ error: 'KYB verification required' });
    }

    req.jeweler = jeweler;
    req.tokenJti = token;
    next();

  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
