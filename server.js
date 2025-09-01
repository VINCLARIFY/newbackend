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
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://localhost:5173",
]);

app.use(
  cors({
    origin(origin, cb) {
      // allow non-browser clients or same-origin
      if (!origin || allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error(`Not allowed by CORS: ${origin}`));
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

// safety: single axios instance
const ax = axios.create({
  baseURL: AIRWALLEX_API_BASE,
  timeout: 15000, // 15s
  headers: { "Content-Type": "application/json" },
});

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
  // Airwallex expects amount in **major units** (e.g., 12.34). Your UI sends whole dollars?
  // If your price is 29 -> keep 29. If you ever send cents, round to 2 decimals:
  return Math.round(n * 100) / 100;
}

function requestId(prefix = "vin") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---- Get Airwallex authentication token (FIXED) ----
async function getAirwallexToken() {
  assertEnv();
  try {
    const { data } = await ax.post("/api/v1/authentication/login", {
      client_id: process.env.AIRWALLEX_CLIENT_ID,
      api_key: process.env.AIRWALLEX_API_KEY,
    });
    if (!data?.token) throw new Error("Missing token in Airwallex response");
    return data.token;
  } catch (err) {
    const code = err.response?.status;
    const body = err.response?.data;
    console.error("Airwallex auth error:", code, body || err.message);
    throw Object.assign(new Error("Payment service unavailable"), { cause: err });
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

    const amt = normalizeAmount(amount);
    if (!amt || !orderId) {
      return res.status(400).json({
        success: false,
        error: "Valid amount (> 0) and orderId are required",
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

    const { data } = await ax.post("/api/v1/pa/payment_intents/create", payload, {
      headers: { Authorization: `Bearer ${token}` },
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
    const code = err.response?.status || 500;
    const body = err.response?.data;
    if (ENV !== "production") {
      console.error("Payment intent error:", code, body || err.message);
    } else {
      console.error("Payment intent error:", code);
    }
    const map =
      code === 401
        ? "Authentication failed with payment provider"
        : code === 400
        ? "Invalid payment request"
        : "Failed to create payment";
    res.status(500).json({
      success: false,
      error: map,
      ...(ENV !== "production" ? { details: body || err.message } : {}),
    });
  }
});

// ---- Confirm Payment (if you’re confirming server-side) ----
app.post("/confirm-payment", async (req, res) => {
  try {
    const { paymentIntentId, paymentMethodId } = req.body || {};
    if (!paymentIntentId || !paymentMethodId) {
      return res.status(400).json({
        success: false,
        error: "paymentIntentId and paymentMethodId are required",
      });
    }

    const token = await getAirwallexToken();
    const payload = { payment_method: { id: paymentMethodId } };

    const { data } = await ax.post(
      `/api/v1/pa/payment_intents/${encodeURIComponent(paymentIntentId)}/confirm`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ success: true, status: data.status, paymentIntent: data });
  } catch (err) {
    const code = err.response?.status || 500;
    const body = err.response?.data;
    if (ENV !== "production") {
      console.error("Payment confirmation error:", code, body || err.message);
    } else {
      console.error("Payment confirmation error:", code);
    }
    const map =
      code === 404
        ? "Payment intent not found"
        : code === 402
        ? "Payment failed - please check your payment details"
        : "Failed to confirm payment";
    res.status(500).json({
      success: false,
      error: map,
      ...(ENV !== "production" ? { details: body || err.message } : {}),
    });
  }
});

// ---- Get Payment Status ----
app.get("/payment-status/:id", async (req, res) => {
  try {
    const id = req.params.id?.trim();
    if (!id) return res.status(400).json({ success: false, error: "Payment ID required" });

    const token = await getAirwallexToken();
    const { data } = await ax.get(`/api/v1/pa/payment_intents/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    res.json({
      success: true,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      customer_id: data.customer_id,
      merchant_order_id: data.merchant_order_id,
    });
  } catch (err) {
    const code = err.response?.status || 500;
    const body = err.response?.data;
    if (ENV !== "production") {
      console.error("Status check error:", code, body || err.message);
    } else {
      console.error("Status check error:", code);
    }
    res.status(500).json({ success: false, error: "Failed to get payment status" });
  }
});

// ---- Webhook (optional; add signature verification before using in prod) ----
app.post("/webhooks/payment-events", (req, res) => {
  try {
    console.log("Received payment event:", req.body?.type, req.body?.id);
    res.json({ received: true });
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(400).json({ error: "Webhook handler failed" });
  }
});

// ---- 404 ----
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Endpoint not found" });
});

// ---- GLOBAL ERROR ----
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

// ======================= SERVER STARTUP =======================
const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Payment processor running on port ${PORT}`);
  console.log(`Environment: ${ENV}`);
  console.log(`Airwallex API: ${AIRWALLEX_API_BASE}`);
});
