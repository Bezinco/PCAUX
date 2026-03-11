export default function handler(req, res) {
  res.status(200).json({ message: 'Hello World' });
}
  // 404 for everything else
  else {
    res.status(404).json({ error: 'Not found' });
  }
}
