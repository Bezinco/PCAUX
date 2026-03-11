import express from 'express';

const app = express();
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Demo status
app.get('/api/demo/status', (req, res) => {
  res.json({ 
    demo_mode: true, 
    status: 'active',
    message: 'API is working! Add your bricks next.',
    timestamp: new Date().toISOString()
  });
});

export default app;
