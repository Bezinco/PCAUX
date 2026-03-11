// Serverless function format for Vercel
export default function handler(req, res) {
  // Health check
  if (req.url === '/api/health' || req.url === '/health') {
    res.status(200).json({ 
      status: 'alive', 
      timestamp: new Date().toISOString() 
    });
  }
  
  // Demo status
  else if (req.url === '/api/demo/status' || req.url === '/demo/status') {
    res.status(200).json({ 
      demo_mode: true, 
      status: 'active',
      message: 'API is working!',
      timestamp: new Date().toISOString()
    });
  }
  
  // Demo players
  else if (req.url === '/api/demo/players' || req.url === '/demo/players') {
    res.status(200).json({
      players: [
        { name: 'WhaleWatcher', personality: 'whale' },
        { name: 'DiamondHands', personality: 'trader' },
        { name: 'QuickFlip', personality: 'scalper' },
        { name: 'GemGatherer', personality: 'collector' }
      ]
    });
  }
  
  // 404 for everything else
  else {
    res.status(404).json({ error: 'Not found' });
  }
}
