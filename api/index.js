// === SIMPLE HELLO API ===
import { createClient } from '@supabase/supabase-js';  // ← NEW

// Initialize Supabase  ← NEW
const supabaseUrl = process.env.SUPABASE_URL;          // ← NEW
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY; // ← NEW

if (!supabaseUrl || !supabaseAnonKey) {                // ← NEW
  console.error('Missing Supabase environment variables'); // ← NEW
}                                                       // ← NEW

const supabase = createClient(supabaseUrl, supabaseAnonKey); // ← NEW

export default async function handler(req, res) {
  const url = req.url;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Hello endpoint
  if (url === '/api/hello' || url === '/hello') {
    return res.status(200).json({ 
      message: 'hello',
      timestamp: new Date().toISOString()
    });
  }

  // Health check
  if (url === '/api/health' || url === '/health') {
    return res.status(200).json({ 
      status: 'alive', 
      timestamp: new Date().toISOString(),
      supabase_configured: !!(supabaseUrl && supabaseAnonKey)  // ← NEW line
    });
  }

  // === NEW SUPABASE TEST ENDPOINT ===
  if (url === '/api/supabase-test' || url === '/supabase-test') {
    try {
      const { data, error } = await supabase
        .from('demo_players')
        .select('*')
        .limit(5);
      
      if (error) throw error;
      
      return res.status(200).json({
        connected: true,
        message: 'Supabase connected',
        data: data || []
      });
    } catch (error) {
      return res.status(500).json({
        connected: false,
        error: error.message
      });
    }
  }

  // 404 for everything else
  return res.status(404).json({ 
    error: 'Not found',
    try: '/api/hello, /api/health, or /api/supabase-test'  // ← UPDATED
  });
}
