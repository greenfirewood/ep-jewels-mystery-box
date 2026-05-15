const express = require('express');
const app = express();
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.send('EP Jewels Mystery Box Engine - Running');
});

// Main assignment endpoint - called by Shopify Flow
app.post('/assign', async (req, res) => {
  const { order_id, preferences } = req.body;
  console.log('Order received:', order_id, preferences);
  res.json({ success: true, message: 'Assignment engine placeholder' });
});

// Availability check endpoint - called by PDP JS
app.post('/availability', async (req, res) => {
  const { preferences } = req.body;
  console.log('Availability check:', preferences);
  res.json({ available: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mystery box engine running on port ${PORT}`);
});