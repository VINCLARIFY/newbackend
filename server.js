// ======================= SETUP =======================
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const morgan = require("morgan");
const helmet = require("helmet");
require("dotenv").config();

const app = express();
app.set("trust proxy", true);

// ======================= MIDDLEWARE =======================
app.use(express.json({ limit: "1mb" }));
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan(process.env.NODE_ENV === "production" ? "tiny" : "dev"));

// ---- CORS ----
const allowedOrigins = new Set([
  "https://vinclarify.info",
  "https://www.vinclarify.info",
  "https://homielife.com",
  "https://www.homielife.com",
  "http://localhost:5173",
  "http://localhost:3000",
]);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      } else {
        console.log(`CORS blocked for origin: ${origin}`);
        return callback(new Error(`Not allowed by CORS: ${origin}`), false);
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
    ],
    credentials: true,
    maxAge: 86400,
  })
);

// Preflight
app.options("*", cors());

// ======================= AIRWALLEX CONFIG =======================
const ENV = process.env.NODE_ENV || "development";
const AIRWALLEX_API_BASE =
  ENV === "production" ? "https://api.airwallex.com" : "https://api-demo.airwallex.com";

// axios instance with better error handling
const ax = axios.create({
  baseURL: AIRWALLEX_API_BASE,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

// Add response interceptor for better error handling
ax.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.code === 'ECONNABORTED') {
      console.error('Airwallex API request timeout');
      return Promise.reject(new Error('Request timeout with payment provider'));
    }
    
    // Log detailed error information
    if (error.response) {
      console.error('Airwallex API Error:', {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    } else if (error.request) {
      console.error('Airwallex API No Response:', error.request);
    } else {
      console.error('Airwallex API Error:', error.message);
    }
    
    return Promise.reject(error);
  }
);

// ======================= HELPERS =======================
function assertEnv() {
  const miss = [];
  if (!process.env.AIRWALLEX_CLIENT_ID) miss.push("AIRWALLEX_CLIENT_ID");
  if (!process.env.AIRWALLEX_API_KEY) miss.push("AIRWALLEX_API_KEY");
  if (miss.length) {
    throw new Error(`Missing environment variables: ${miss.join(", ")}`);
  }
}

function normalizeAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Convert to cents for Airwallex
  return Math.round(n * 100);
}

function requestId(prefix = "vin") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---- Get Airwallex authentication token ----
async function getAirwallexToken() {
  assertEnv();
  try {
    const authString = Buffer.from(
      `${process.env.AIRWALLEX_CLIENT_ID}:${process.env.AIRWALLEX_API_KEY}`
    ).toString('base64');

    const response = await ax.post("/api/v1/authentication/login", {}, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.data?.token) {
      throw new Error("Missing token in Airwallex response");
    }
    
    return response.data.token;
  } catch (err) {
    console.error("Airwallex auth error details:", {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data
    });
    
    if (err.response?.status === 401) {
      throw new Error("Invalid Airwallex credentials. Please check your CLIENT_ID and API_KEY.");
    } else if (err.response?.status >= 500) {
      throw new Error("Payment service temporarily unavailable. Please try again later.");
    } else if (err.message.includes("timeout")) {
      throw new Error("Connection to payment provider timed out.");
    } else {
      throw new Error(`Failed to authenticate with payment provider: ${err.message}`);
    }
  }
}

// ======================= ROUTES =======================

// Root
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "VINClarify Payment Backend",
    env: ENV,
    airwallexBase: AIRWALLEX_API_BASE,
    time: new Date().toISOString(),
  });
});

// Health
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    service: "VINClarify Payment Processor",
    timestamp: new Date().toISOString(),
  });
});

// ---- Create Payment Intent ----
app.post("/create-payment-intent", async (req, res) => {
  try {
    console.log("Received request to create payment intent:", {
      body: req.body,
      headers: req.headers
    });

    const { amount, currency = "USD", orderId } = req.body || {};

    if (!amount || !orderId) {
      console.error("Missing required fields:", { amount, orderId });
      return res.status(400).json({
        success: false,
        error: "Amount and orderId are required",
      });
    }

    const amt = normalizeAmount(amount);
    if (!amt || amt <= 0) {
      console.error("Invalid amount:", amount);
      return res.status(400).json({
        success: false,
        error: "Valid amount (> 0) is required",
      });
    }

    const token = await getAirwallexToken();
    const reqId = requestId("pi");

    const payload = {
      request_id: reqId,
      amount: amt,
      currency,
      merchant_order_id: String(orderId),
      order: {
        products: [
          {
            name: "Vehicle History Report",
            quantity: 1,
            unit_price: amt,
          },
        ],
      },
    };

    console.log("Creating payment intent with payload:", payload);
    
    const response = await ax.post("/api/v1/pa/payment_intents/create", payload, {
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
    });

    console.log("Payment intent created successfully:", {
      id: response.data.id,
      status: response.data.status
    });

    return res.json({
      success: true,
      id: response.data.id,
      client_secret: response.data.client_secret,
      status: response.data.status,
      amount: response.data.amount,
      currency: response.data.currency,
    });
  } catch (err) {
    console.error("Payment intent creation error:", {
      message: err.message,
      stack: err.stack,
      response: err.response?.data
    });
    
    let statusCode = 500;
    let errorMessage = "Failed to create payment intent";
    
    if (err.message.includes("credentials") || err.message.includes("Unauthorized")) {
      statusCode = 500;
      errorMessage = "Payment configuration error. Please check your API credentials.";
    } else if (err.message.includes("temporarily unavailable")) {
      statusCode = 503;
      errorMessage = "Payment service temporarily unavailable. Please try again later.";
    } else if (err.message.includes("timeout")) {
      statusCode = 504;
      errorMessage = "Payment provider timeout. Please try again.";
    }
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: ENV !== "production" ? err.message : undefined,
    });
  }
});

// ======================= ERROR HANDLING MIDDLEWARE =======================
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: ENV !== 'production' ? error.message : undefined
  });
});

// ======================= SERVER STARTUP =======================
const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Payment processor running on port ${PORT}`);
  console.log(`Environment: ${ENV}`);
  console.log(`Airwallex API: ${AIRWALLEX_API_BASE}`);
  
  // Test that required environment variables are set
  try {
    assertEnv();
    console.log("✓ Environment variables are properly configured");
  } catch (err) {
    console.error("✗ Missing environment variables:", err.message);
    console.error("Please check your AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY environment variables");
  }
});