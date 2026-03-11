export default function handler(req, res) {
  res.status(200).json({ 
    status: 'alive', 
    timestamp: new Date().toISOString() 
  });
}
