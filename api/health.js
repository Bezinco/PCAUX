export default function handler(req, res) {
  const url = req.url;
  
  // Health check
  if (url === '/api/health' || url === '/health') {
    res.status(200).json({ 
      status: 'alive', 
      timestamp: new Date().toISOString() 
    });
  }
  
  // Demo status
  else if (url === '/api/demo/status' || url === '/demo/status') {
    res.status(200).json({ 
      demo_mode: true, 
      status: 'active',
      message: 'API is working!',
      timestamp: new Date().toISOString()
    });
  }
  
  // Demo players
  else if (url === '/api/demo/players' || url === '/demo/players') {
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
