export default function handler(req, res) {
  const url = req.url;
  
  // Health check
  if (url === '/api/health' || url === '/health') {
    return res.status(200).json({ 
      status: 'alive', 
      timestamp: new Date().toISOString() 
    });
  }
  
  // Demo players
  if (url === '/api/demo/players' || url === '/demo/players') {
    return res.status(200).json({
      players: [
        { name: 'WhaleWatcher', personality: 'whale', aggression: 0.7 },
        { name: 'DiamondHands', personality: 'trader', aggression: 0.9 },
        { name: 'QuickFlip', personality: 'scalper', aggression: 0.85 },
        { name: 'GemGatherer', personality: 'collector', aggression: 0.3 }
      ]
    });
  }
  
  // 404 for everything else
  return res.status(404).json({ error: 'Not found' });
}
