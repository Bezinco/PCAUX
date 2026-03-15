// api/index.js
// Import from archive (hidden from Vercel)
import { getDemoPlayers, getDemoStatus, getDemoActivity, getDemoFeed } from '../archive/bricks/brick-12-demo-market-hardened.js';
// Import other bricks as needed
// import { authHandler } from '../archive/bricks/brick-01-auth.js';
// import { sleeveHandler } from '../archive/bricks/brick-02-sleeve.js';
// etc.

export default async function handler(req, res) {
  const fullPath = req.url || '';
  const path = fullPath.replace(/^\/api\//, '').split('?')[0] || '';
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') return res.status(200).end();

  try {
    // === HEALTH CHECK ===
    if (path === 'health' || path === '') {
      return res.status(200).json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        path: fullPath
      });
    }

    // === HELLO ===
    if (path === 'hello') {
      return res.status(200).json({ message: 'hello from PCAUX' });
    }

    // === DEMO PLAYERS (from brick-12) ===
    if (path === 'demo/players') {
      return await getDemoPlayers(req, res);
    }

    // === DEMO STATUS (from brick-12) ===
    if (path === 'demo/status') {
      return await getDemoStatus(req, res);
    }

    // === DEMO ACTIVITY (from brick-12) ===
    if (path === 'demo/activity') {
      return await getDemoActivity(req, res);
    }

    // === DEMO FEED (from brick-12) ===
    if (path === 'demo/feed') {
      return await getDemoFeed(req, res);
    }

    // === 404 ===
    return res.status(404).json({ 
      error: 'Not found', 
      path: fullPath,
      available: ['/api/health', '/api/hello', '/api/demo/players', '/api/demo/status', '/api/demo/activity', '/api/demo/feed']
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: 'Internal error', 
      message: error.message 
    });
  }
}
