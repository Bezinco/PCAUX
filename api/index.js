// === IMPORT ALL BRICKS ===
import authBrick from './src/bricks/brick-01-auth.js';
import sleeveBrick from './src/bricks/brick-02-sleeve.js';
import ipoBrick from './src/bricks/brick-03-ipo.js';
import tradingBrick from './src/bricks/brick-04-trading.js';
import gradingBrick from './src/bricks/brick-05-grading.js';
import settlementBrick from './src/bricks/brick-06-settlement.js';
import qualityKingBrick from './src/bricks/brick-07-quality-king.js';
import adminBrick from './src/bricks/brick-08-admin.js';
import pcuBrick from './src/bricks/brick-11-pcu-crypto.js';
import demoBrick from './src/bricks/brick-12-demo-market-hardened.js';

// === MASTER HANDLER ===
export default async function handler(req, res) {
  const url = req.url;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // === BRICK 1: AUTH ===
    if (url.startsWith('/api/auth')) {
      return await authBrick(req, res);
    }

    // === BRICK 2: SLEEVE ===
    if (url.startsWith('/api/sleeve') || url.startsWith('/api/diamonds')) {
      return await sleeveBrick(req, res);
    }

    // === BRICK 3: IPO ===
    if (url.startsWith('/api/ipo')) {
      return await ipoBrick(req, res);
    }

    // === BRICK 4: TRADING ===
    if (url.startsWith('/api/trading') || url.startsWith('/api/orders')) {
      return await tradingBrick(req, res);
    }

    // === BRICK 5: GRADING ===
    if (url.startsWith('/api/grading')) {
      return await gradingBrick(req, res);
    }

    // === BRICK 6: SETTLEMENT ===
    if (url.startsWith('/api/settlement') || url.startsWith('/api/redeem')) {
      return await settlementBrick(req, res);
    }

    // === BRICK 7: QUALITY KING ===
    if (url.startsWith('/api/quality-king') || url.startsWith('/api/leaderboard')) {
      return await qualityKingBrick(req, res);
    }

    // === BRICK 8: ADMIN ===
    if (url.startsWith('/api/admin')) {
      return await adminBrick(req, res);
    }

    // === BRICK 11: PCU CRYPTO ===
    if (url.startsWith('/api/pcu')) {
      return await pcuBrick(req, res);
    }

    // === BRICK 12: DEMO MARKET ===
    if (url.startsWith('/api/demo')) {
      if (url === '/api/demo/players' || url === '/demo/players') {
        const { getDemoPlayers } = await import('./src/bricks/brick-12-demo-market-hardened.js');
        return await getDemoPlayers(req, res);
      }

      if (url === '/api/demo/status' || url === '/demo/status') {
        const { getDemoStatus } = await import('./src/bricks/brick-12-demo-market-hardened.js');
        return await getDemoStatus(req, res);
      }

      return res.status(404).json({ error: 'Demo endpoint not found' });
    }

    // === HEALTH CHECK ===
    if (url === '/api/health' || url === '/health') {
      return res.status(200).json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        bricks: '12 bricks ready'
      });
    }

    // === 404 ===
    return res.status(404).json({ error: 'Endpoint not found' });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
