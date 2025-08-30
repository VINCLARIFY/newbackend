const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Airwallex Access Token
async function getAccessToken() {
  const auth = Buffer.from(`${process.env.AIRWALLEX_CLIENT_ID}:${process.env.AIRWALLEX_CLIENT_SECRET}`).toString('base64');
  const response = await axios.post('https://ap-gateway.airwallex.com/api/v1/authentication/login', {}, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  });
  return response.data.access_token;
}

// Create Payment Intent
app.post('/create-payment', async (req, res) => {
  try {
    const { amount, currency } = req.body;
    const token = await getAccessToken();
    const paymentIntent = await axios.post('https://ap-gateway.airwallex.com/api/v1/payments/payment_intents', {
      amount,
      currency,
      capture_method: 'automatic'
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    res.json(paymentIntent.data);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Payment failed' });
  }
});

app.listen(5000, () => console.log('Airwallex backend running on port 5000'));
