// === SIMPLE HELLO API ===
export default async function handler(req, res) {
  const url = req.url;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Hello endpoint
  if (url === '/api/hello' || url === '/hello') {
    return res.status(200).json({ 
      message: 'hello',
      timestamp: new Date().toISOString()
    });
  }

  // Health check
  if (url === '/api/health' || url === '/health') {
    return res.status(200).json({ 
      status: 'alive', 
      timestamp: new Date().toISOString() 
    });
  }

  // 404 for everything else
  return res.status(404).json({ 
    error: 'Not found',
    try: '/api/hello or /api/health'
  });
}
}
