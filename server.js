// ======================= SETUP =======================
const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

const app = express();

// ======================= MIDDLEWARE =======================
app.use(express.json());

// CORS configuration
const allowedOrigins = [
  "https://vinclarify.info", // your live site
  "http://localhost:3000",   // local development
  "http://127.0.0.1:5500"    // common local server port
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  })
);

// Handle preflight requests
app.options('*', cors());

// ======================= AIRWALLEX CONFIG =======================
const AIRWALLEX_API_BASE = process.env.NODE_ENV === "production" 
  ? "https://api.airwallex.com" 
  : "https://api-demo.airwallex.com";

// ======================= HELPER FUNCTIONS =======================
// Get Airwallex authentication token
async function getAirwallexToken() {
  try {
    const authString = Buffer.from(
      `${process.env.AIRWALLEX_CLIENT_ID}:${process.env.AIRWALLEX_API_KEY}`
    ).toString("base64");

    const response = await axios.post(
      `${AIRWALLEX_API_BASE}/api/v1/authentication/login`,
      {},
      {
        headers: {
          Authorization: `Basic ${authString}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.token;
  } catch (error) {
    console.error("Airwallex auth error:", error.response?.data || error.message);
    throw new Error("Payment service unavailable");
  }
}

// Validate payment data
function validatePaymentData(amount, orderId) {
  if (!amount || !orderId || isNaN(amount) || amount <= 0) {
    return { valid: false, error: "Valid amount and order ID required" };
  }
  
  // Convert to number if it's a string
  const numericAmount = Number(amount);
  if (numericAmount <= 0) {
    return { valid: false, error: "Amount must be greater than 0" };
  }
  
  return { valid: true, amount: numericAmount };
}

// ======================= ROUTES =======================

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    service: "VINClarify Payment Processor",
    timestamp: new Date().toISOString(),
  });
});

// Create Payment Intent
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency = "USD", orderId } = req.body;

    // Validate input
    const validation = validatePaymentData(amount, orderId);
    if (!validation.valid) {
      return res.status(400).json({
        error: validation.error,
        success: false,
      });
    }

    const token = await getAirwallexToken();
    const requestId = `vin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const paymentIntentData = {
      request_id: requestId,
      amount: validation.amount,
      currency,
      merchant_order_id: orderId,
      order: {
        products: [
          {
            name: "Vehicle History Report",
            quantity: 1,
            unit_price: validation.amount,
          },
        ],
      },
    };

    const response = await axios.post(
      `${AIRWALLEX_API_BASE}/api/v1/pa/payment_intents/create`,
      paymentIntentData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({
      success: true,
      id: response.data.id,
      client_secret: response.data.client_secret,
      status: response.data.status,
      amount: response.data.amount,
      currency: response.data.currency,
    });
  } catch (error) {
    console.error("Payment intent error:", error.response?.data || error.message);
    
    // Provide more specific error messages
    let errorMessage = "Failed to create payment";
    if (error.response?.status === 401) {
      errorMessage = "Authentication failed with payment provider";
    } else if (error.response?.status === 400) {
      errorMessage = "Invalid payment request";
    }
    
    res.status(500).json({
      error: errorMessage,
      success: false,
      details: process.env.NODE_ENV === "development" ? error.response?.data : undefined,
    });
  }
});

// Confirm Payment
app.post("/confirm-payment", async (req, res) => {
  try {
    const { paymentIntentId, paymentMethodId } = req.body;

    if (!paymentIntentId || !paymentMethodId) {
      return res.status(400).json({ 
        error: "Payment intent ID and payment method ID required", 
        success: false 
      });
    }

    const token = await getAirwallexToken();

    const confirmData = {
      payment_method: {
        id: paymentMethodId,
      },
    };

    const response = await axios.post(
      `${AIRWALLEX_API_BASE}/api/v1/pa/payment_intents/${paymentIntentId}/confirm`,
      confirmData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({
      success: true,
      status: response.data.status,
      paymentIntent: response.data,
    });
  } catch (error) {
    console.error("Payment confirmation error:", error.response?.data || error.message);
    
    let errorMessage = "Failed to confirm payment";
    if (error.response?.status === 404) {
      errorMessage = "Payment intent not found";
    } else if (error.response?.status === 402) {
      errorMessage = "Payment failed - please check your payment details";
    }
    
    res.status(500).json({
      error: errorMessage,
      success: false,
      details: process.env.NODE_ENV === "development" ? error.response?.data : undefined,
    });
  }
});

// Get payment status
app.get("/payment-status/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ 
        error: "Payment ID required", 
        success: false 
      });
    }

    const token = await getAirwallexToken();
    const response = await axios.get(
      `${AIRWALLEX_API_BASE}/api/v1/pa/payment_intents/${id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({
      success: true,
      status: response.data.status,
      amount: response.data.amount,
      currency: response.data.currency,
      customer_id: response.data.customer_id,
      merchant_order_id: response.data.merchant_order_id,
    });
  } catch (error) {
    console.error("Status check error:", error.response?.data || error.message);
    res.status(500).json({ 
      error: "Failed to get payment status", 
      success: false 
    });
  }
});

// Webhook handler for payment events (for future use)
app.post("/webhooks/payment-events", async (req, res) => {
  try {
    // In a production environment, you would verify the webhook signature here
    const event = req.body;
    
    console.log("Received payment event:", event.type, event.id);
    
    // Handle different event types
    switch (event.type) {
      case "payment_intent.succeeded":
        console.log("Payment succeeded:", event.data.object.id);
        // Update your database, send confirmation email, etc.
        break;
      case "payment_intent.payment_failed":
        console.log("Payment failed:", event.data.object.id, event.data.object.last_payment_error);
        // Handle failed payment
        break;
      default:
        console.log("Unhandled event type:", event.type);
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(400).json({ error: "Webhook handler failed" });
  }
});

// Fallback for unknown routes
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found', 
    success: false 
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({ 
    error: 'Internal server error', 
    success: false 
  });
});

// ======================= SERVER STARTUP =======================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Payment processor running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});