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
  "http://localhost:3000", // Added for local testing
]);

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like mobile apps, curl, postman)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      } else {
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
  timeout: 30000, // Increased to 30s
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

// ---- Get Airwallex authentication token (UPDATED) ----
async function getAirwallexToken() {
  assertEnv();
  try {
    const authString = Buffer.from(
      `${process.env.AIRWALLEX_CLIENT_ID}:${process.env.AIRWALLEX_API_KEY}`
    ).toString('base64');

    const { data } = await ax.post("/api/v1/authentication/login", {}, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!data?.token) throw new Error("Missing token in Airwallex response");
    return data.token;
  } catch (err) {
    console.error("Airwallex auth error:", err.response?.status, err.response?.data || err.message);
    
    if (err.response?.status === 401) {
      throw new Error("Invalid Airwallex credentials");
    } else if (err.response?.status >= 500) {
      throw new Error("Payment service temporarily unavailable");
    } else {
      throw new Error("Failed to authenticate with payment provider");
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
    const { amount, currency = "USD", orderId } = req.body || {};

    if (!amount || !orderId) {
      return res.status(400).json({
        success: false,
        error: "Amount and orderId are required",
      });
    }

    const amt = normalizeAmount(amount);
    if (!amt || amt <= 0) {
      return res.status(400).json({
        success: false,
        error: "Valid amount (> 0) is required",
      });
    }

    const token = await getAirwallexToken();
    const reqId = requestId("pi");

    const payload = {
      request_id: reqId,
      amount: amt, // Amount in cents
      currency,
      merchant_order_id: String(orderId),
      order: {
        products: [
          {
            name: "Vehicle History Report",
            quantity: 1,
            unit_price: amt, // Unit price in cents
          },
        ],
      },
    };

    const { data } = await ax.post("/api/v1/pa/payment_intents/create", payload, {
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
    });

    return res.json({
      success: true,
      id: data.id,
      client_secret: data.client_secret,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
    });
  } catch (err) {
    console.error("Payment intent creation error:", err.message);
    
    let statusCode = 500;
    let errorMessage = "Failed to create payment intent";
    
    if (err.message.includes("credentials") || err.message.includes("Unauthorized")) {
      statusCode = 500;
      errorMessage = "Payment configuration error";
    } else if (err.message.includes("temporarily unavailable")) {
      statusCode = 503;
      errorMessage = "Payment service temporarily unavailable";
    }
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      ...(ENV !== "production" ? { details: err.message } : {}),
    });
  }
});

// Other routes remain the same as in your original code...

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
  }
});