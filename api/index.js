// api/[path].js
import { Pool } from 'pg';

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

export default async function handler(req, res) {
  const path = req.query.path || '';
  const fullPath = `/api/${path}`;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') return res.status(200).end();

  try {
    // Health check
    if (path === 'health' || path === '') {
      return res.status(200).json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        service: path === '' ? 'PCAUX API' : undefined
      });
    }

    // Hello
    if (path === 'hello') {
      return res.status(200).json({ message: 'hello from PCAUX' });
    }

    // Demo players
    if (path === 'demo/players') {
      return res.status(200).json({
        players: [
          { name: 'DiamondKing', rank: 1 },
          { name: 'RubyQueen', rank: 2 }
        ]
      });
    }

    // 404
    return res.status(404).json({ error: 'Not found', path: fullPath });

  } catch (error) {
    return res.status(500).json({ error: 'Internal error' });
  }
}
 
