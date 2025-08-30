const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Airwallex API Configuration
const AIRWALLEX_API_BASE = process.env.NODE_ENV === 'production' 
  ? 'https://api.airwallex.com' 
  : 'https://api-demo.airwallex.com';

// Get Airwallex authentication token
async function getAirwallexToken() {
  try {
    const authString = Buffer.from(`${process.env.AIRWALLEX_CLIENT_ID}:${process.env.AIRWALLEX_API_KEY}`).toString('base64');
    const response = await axios.post(`${AIRWALLEX_API_BASE}/api/v1/authentication/login`, {}, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data.token;
  } catch (error) {
    console.error('Airwallex auth error:', error.response?.data || error.message);
    throw new Error('Payment service unavailable');
  }
}

// Create Payment Intent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'USD', orderId } = req.body;
    if (!amount || !orderId || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount and order ID required', success: false });
    }

    const token = await getAirwallexToken();
    const requestId = `vin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const paymentIntentData = {
      request_id: requestId,
      amount: Number(amount),
      currency,
      merchant_order_id: orderId,
      order: {
        products: [
          { name: 'Vehicle History Report', quantity: 1, unit_price: Number(amount) }
        ]
      }
    };

    const response = await axios.post(
      `${AIRWALLEX_API_BASE}/api/v1/pa/payment_intents/create`,
      paymentIntentData,
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    res.json({
      success: true,
      id: response.data.id,
      client_secret: response.data.client_secret,
      status: response.data.status,
      amount: response.data.amount,
      currency: response.data.currency
    });

  } catch (error) {
    console.error('Payment intent error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to create payment', 
      success: false, 
      details: process.env.NODE_ENV === 'development' ? error.response?.data : undefined
    });
  }
});

// Get payment status
app.get('/payment-status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Payment ID required', success: false });

    const token = await getAirwallexToken();
    const response = await axios.get(
      `${AIRWALLEX_API_BASE}/api/v1/pa/payment_intents/${id}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    res.json({
      success: true,
      status: response.data.status,
      amount: response.data.amount,
      currency: response.data.currency
    });
  } catch (error) {
    console.error('Status check error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to get payment status', success: false });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'Payment Processor', timestamp: new Date().toISOString() });
});

// Handle unknown routes (updated to use regex)
app.all(/.*/, (req, res) => {
  res.status(404).json({ error: 'Endpoint not found', success: false });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Payment processor running on port ${PORT}`));
