export default function handler(req, res) {
  const url = req.url;
  
  if (url.includes('/health')) {
    return res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
  }
  
  if (url.includes('/demo/players')) {
    return res.status(200).json({
      players: [
        { name: 'WhaleWatcher', personality: 'whale' },
        { name: 'DiamondHands', personality: 'trader' }
      ]
    });
  }
  
  return res.status(404).json({ error: 'Not found' });
}
