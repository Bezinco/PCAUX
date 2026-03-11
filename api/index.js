export default function handler(req, res) {
  const url = req.url;

  // === HEALTH CHECK ===
  if (url === '/api/health' || url === '/health') {
    return res.status(200).json({ 
      status: 'alive', 
      timestamp: new Date().toISOString() 
    });
  }

  // === DEMO PLAYERS ===
  if (url === '/api/demo/players' || url === '/demo/players') {
    return res.status(200).json({
      players: [
        { name: 'WhaleWatcher', personality: 'whale' },
        { name: 'DiamondHands', personality: 'trader' },
        { name: 'QuickFlip', personality: 'scalper' },
        { name: 'GemGatherer', personality: 'collector' }
      ]
    });
  }

  // === DEMO STATUS ===
  if (url === '/api/demo/status' || url === '/demo/status') {
    return res.status(200).json({
      demo_mode: true,
      active_players: 4,
      volume_24h: '125,000 PCU',
      active_gems: 12
    });
  }

  // === QUALITY KINGS ===
  if (url === '/api/quality-kings' || url === '/quality-kings') {
    return res.status(200).json({
      jewelers: [
        { name: 'Raj Gems', tier: 'gold', score: 750 },
        { name: 'Maya Precious', tier: 'platinum', score: 1200 }
      ]
    });
  }

  // === PCU BALANCES ===
  if (url === '/api/pcu/balances' || url === '/pcu/balances') {
    return res.status(200).json({
      balances: [
        { address: '0x123...', balance: 5000 },
        { address: '0x456...', balance: 12500 }
      ]
    });
  }

  // === NOT FOUND ===
  return res.status(404).json({ 
    error: 'Not found', 
    requested: url 
  });
}
