// === SIMPLE HELLO API WITH SUPABASE ===
export default async function handler(req, res) {
  const url = req.url;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');

  // === HEALTH CHECK ===
  if (url === '/api/health' || url === '/health') {
    return res.status(200).json({ 
      status: 'alive', 
      timestamp: new Date().toISOString(),
      supabase_configured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
    });
  }

  // === HELLO ENDPOINT ===
  if (url === '/api/hello' || url === '/hello') {
    return res.status(200).json({ 
      message: 'hello',
      timestamp: new Date().toISOString()
    });
  }

  // === SUPABASE TEST ENDPOINT ===
  if (url === '/api/supabase-test' || url === '/supabase-test') {
    try {
      // Dynamically import Supabase (so it doesn't break if env vars missing)
      const { createClient } = await import('@supabase/supabase-js');
      
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
      
      if (!supabaseUrl || !supabaseAnonKey) {
        return res.status(500).json({
          connected: false,
          error: 'Missing Supabase environment variables'
        });
      }
      
      const supabase = createClient(supabaseUrl, supabaseAnonKey);
      
      // Try to query the demo_players table
      const { data, error } = await supabase
        .from('demo_players')
        .select('*')
        .limit(5);
      
      if (error) throw error;
      
      return res.status(200).json({
        connected: true,
        message: '✅ Supabase connected successfully',
        table_exists: data !== null,
        row_count: data?.length || 0,
        sample_data: data || []
      });
    } catch (error) {
      return res.status(500).json({
        connected: false,
        error: error.message,
        hint: 'Make sure the demo_players table exists in Supabase'
      });
    }
  }

  // === ROOT ENDPOINT ===
  if (url === '/' || url === '/api') {
    return res.status(200).json({
      service: 'PCAUX API',
      endpoints: [
        '/api/health',
        '/api/hello',
        '/api/supabase-test'
      ]
    });
  }

  // === 404 FOR EVERYTHING ELSE ===
  return res.status(404).json({ 
    error: 'Not found',
    available: ['/api/health', '/api/hello', '/api/supabase-test']
  });
}
