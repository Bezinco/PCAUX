export default function handler(req, res) {
  res.status(200).json({
    players: [
      { name: 'WhaleWatcher', personality: 'whale' },
      { name: 'DiamondHands', personality: 'trader' },
      { name: 'QuickFlip', personality: 'scalper' },
      { name: 'GemGatherer', personality: 'collector' }
    ]
  });
}
