// api/[...path].js
// PCAUX Diamond Platform - Catch-all handler for Vercel serverless

import { Pool } from 'pg';

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

export default async function handler(req, res) {
  const pathSegments = req.query.path || [];
  const path = pathSegments.join('/');
  const fullPath = `/api/${path}`;
  const method = req.method;
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // === HEALTH CHECK (also handles root /api) ===
    if (path === 'health' || path === '') {
      return res.status(200).json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        path: fullPath,
        database: pool ? 'configured' : 'not configured',
        service: path === '' ? 'PCAUX API' : undefined,
        endpoints: path === '' ? [
          'GET /api/health',
          'GET /api/hello',
          'GET /api/supabase-test',
          'GET /api/demo/players',
          'GET /api/demo/status',
          'GET /api/demo/activity',
          'GET /api/demo/feed'
        ] : undefined
      });
    }

    // === HELLO ===
    if (path === 'hello') {
      return res.status(200).json({ 
        message: 'hello from PCAUX',
        timestamp: new Date().toISOString()
      });
    }

    // === SUPABASE TEST ===
    if (path === 'supabase-test') {
      return await handleSupabaseTest(req, res);
    }

    // === DEMO ENDPOINTS ===
    if (path === 'demo/players') {
      return await handleDemoPlayers(req, res);
    }
    if (path === 'demo/status') {
      return await handleDemoStatus(req, res);
    }
    if (path === 'demo/activity') {
      return await handleDemoActivity(req, res);
    }
    if (path === 'demo/feed') {
      return await handleDemoFeed(req, res);
    }

    // === 404 ===
    return res.status(404).json({ 
      error: 'Not found',
      path: fullPath,
      available: ['/api/health', '/api/hello', '/api/supabase-test', '/api/demo/*']
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// === HANDLER FUNCTIONS ===

async function handleSupabaseTest(req, res) {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseAnonKey) {
      return res.status(500).json({
        connected: false,
        error: 'Missing Supabase environment variables',
        required: ['SUPABASE_URL', 'SUPABASE_ANON_KEY']
      });
    }
    
    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    
    // Test connection by getting server time or health check
    const { data, error } = await supabase.from('players').select('count', { count: 'exact', head: true });
    
    if (error) {
      return res.status(500).json({
        connected: false,
        error: error.message,
        hint: 'Check if the players table exists and RLS policies allow access'
      });
    }
    
    return res.status(200).json({
      connected: true,
      timestamp: new Date().toISOString(),
      supabaseUrl: supabaseUrl.replace(/\/\/[^@]+@/, '//[hidden]@'), // Hide credentials
      tables: ['players'],
      testQuery: 'success'
    });
    
  } catch (error) {
    console.error('Supabase test error:', error);
    return res.status(500).json({
      connected: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

async function handleDemoPlayers(req, res) {
  const method = req.method;
  
  try {
    if (method === 'GET') {
      // Return mock player data
      const players = [
        {
          id: 'p1',
          name: 'DiamondKing',
          rank: 1,
          level: 85,
          diamonds: 15420,
          status: 'online',
          avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=DiamondKing',
          lastActive: new Date().toISOString(),
          stats: { wins: 342, losses: 12, draws: 5 }
        },
        {
          id: 'p2',
          name: 'RubyQueen',
          rank: 2,
          level: 82,
          diamonds: 12800,
          status: 'in-game',
          avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=RubyQueen',
          lastActive: new Date(Date.now() - 300000).toISOString(),
          stats: { wins: 298, losses: 45, draws: 8 }
        },
        {
          id: 'p3',
          name: 'EmeraldAce',
          rank: 3,
          level: 78,
          diamonds: 9450,
          status: 'offline',
          avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=EmeraldAce',
          lastActive: new Date(Date.now() - 86400000).toISOString(),
          stats: { wins: 201, losses: 67, draws: 12 }
        }
      ];
      
      return res.status(200).json({
        players,
        total: players.length,
        timestamp: new Date().toISOString()
      });
    }
    
    if (method === 'POST') {
      // Create new player (mock)
      const newPlayer = {
        id: `p${Date.now()}`,
        ...req.body,
        createdAt: new Date().toISOString(),
        diamonds: 0,
        level: 1,
        rank: null
      };
      
      return res.status(201).json({
        message: 'Player created (demo)',
        player: newPlayer
      });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Demo players error:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function handleDemoStatus(req, res) {
  try {
    // Simulate platform status metrics
    const status = {
      platform: 'PCAUX Diamond',
      version: '1.0.0-demo',
      status: 'operational',
      uptime: '99.9%',
      timestamp: new Date().toISOString(),
      metrics: {
        activePlayers: 1247,
        gamesInProgress: 89,
        totalDiamonds: 8943200,
        serverLoad: 42,
        responseTime: '45ms'
      },
      regions: {
        'us-east': { status: 'healthy', latency: '23ms' },
        'us-west': { status: 'healthy', latency: '45ms' },
        'eu-west': { status: 'healthy', latency: '67ms' },
        'ap-south': { status: 'degraded', latency: '120ms' }
      },
      features: {
        matchmaking: 'enabled',
        trading: 'enabled',
        tournaments: 'maintenance',
        chat: 'enabled'
      }
    };
    
    return res.status(200).json(status);
    
  } catch (error) {
    console.error('Demo status error:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function handleDemoActivity(req, res) {
  try {
    const activities = [
      {
        id: 'act1',
        type: 'diamond_purchase',
        player: 'DiamondKing',
        description: 'Purchased 500 diamonds',
        amount: 500,
        timestamp: new Date(Date.now() - 120000).toISOString(),
        icon: '💎'
      },
      {
        id: 'act2',
        type: 'level_up',
        player: 'RubyQueen',
        description: 'Reached level 83',
        timestamp: new Date(Date.now() - 300000).toISOString(),
        icon: '⬆️'
      },
      {
        id: 'act3',
        type: 'tournament_win',
        player: 'EmeraldAce',
        description: 'Won Sapphire Tournament',
        reward: '2000 diamonds',
        timestamp: new Date(Date.now() - 600000).toISOString(),
        icon: '🏆'
      },
      {
        id: 'act4',
        type: 'trade',
        player: 'DiamondKing',
        description: 'Traded with RubyQueen',
        details: 'Rare Gem for 1000 diamonds',
        timestamp: new Date(Date.now() - 900000).toISOString(),
        icon: '🤝'
      },
      {
        id: 'act5',
        type: 'achievement',
        player: 'SapphirePro',
        description: 'Unlocked "Diamond Collector"',
        timestamp: new Date(Date.now() - 1200000).toISOString(),
        icon: '🎯'
      }
    ];
    
    return res.status(200).json({
      activities,
      count: activities.length,
      lastUpdated: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Demo activity error:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function handleDemoFeed(req, res) {
  try {
    const feed = [
      {
        id: 'feed1',
        type: 'announcement',
        title: 'Welcome to PCAUX Diamond Platform',
        content: 'Experience the next generation of diamond trading and gaming.',
        author: 'PCAUX Team',
        priority: 'high',
        timestamp: new Date(Date.now() - 3600000).toISOString(),
        tags: ['welcome', 'beta']
      },
      {
        id: 'feed2',
        type: 'update',
        title: 'New Tournament: Winter Championship',
        content: 'Join the Winter Championship starting next week with a prize pool of 50,000 diamonds!',
        author: 'Tournament Admin',
        priority: 'medium',
        timestamp: new Date(Date.now() - 7200000).toISOString(),
        tags: ['tournament', 'event', 'winter'],
        action: {
          label: 'Register Now',
          url: '/tournaments/winter-championship'
        }
      },
      {
        id: 'feed3',
        type: 'feature',
        title: 'Trading System v2.0 Released',
        content: 'Faster trades, better security, and new rare items available.',
        author: 'Product Team',
        priority: 'medium',
        timestamp: new Date(Date.now() - 86400000).toISOString(),
        tags: ['update', 'trading'],
        image: 'https://via.placeholder.com/400x200/3b82f6/ffffff?text=Trading+v2.0'
      },
      {
        id: 'feed4',
        type: 'alert',
        title: 'Scheduled Maintenance',
        content: 'Platform will be under maintenance on Sunday 2AM UTC for 2 hours.',
        author: 'System',
        priority: 'high',
        timestamp: new Date(Date.now() - 172800000).toISOString(),
        tags: ['maintenance', 'alert']
      }
    ];
    
    return res.status(200).json({
      feed,
      unread: feed.filter(f => f.priority === 'high').length,
      lastUpdated: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Demo feed error:', error);
    return res.status(500).json({ error: error.message });
  }
}
