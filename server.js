require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const admin = require("firebase-admin");
const midtransClient = require("midtrans-client");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const winston = require("winston");

const app = express();

/* ================= SECURITY ================= */
app.use(helmet());
app.use(cors());
app.use(express.json());

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100
}));

/* ================= LOGGER ================= */
const logger = winston.createLogger({
  level: "info",
  transports: [new winston.transports.Console()]
});

/* ================= ENV VALIDATION ================= */
const requiredEnv = [
  "MIDTRANS_SERVER_KEY",
  "MIDTRANS_CLIENT_KEY",
  "FB_PROJECT_ID",
  "FB_CLIENT_EMAIL",
  "FB_PRIVATE_KEY"
];

requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    throw new Error(`Missing required env variable: ${key}`);
  }
});

/* ================= FIREBASE INIT ================= */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FB_PROJECT_ID,
    clientEmail: process.env.FB_CLIENT_EMAIL,
    privateKey: process.env.FB_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/* ================= MIDTRANS INIT ================= */
const snap = new midtransClient.Snap({
  isProduction: true,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

/* ================= ROOT ================= */
app.get("/", (req, res) => {
  res.status(200).json({
    status: "OK",
    app: "app.rayanxweb.topup",
    message: "API is running 🚀",
    timestamp: new Date(),
  });
});

/* ================= HEALTH ================= */
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* ================= CREATE TOPUP ================= */
app.post("/api/topup", async (req, res) => {
  try {
    const { uid, amount } = req.body;

    if (!uid || !amount || amount < 10000) {
      return res.status(400).json({ message: "Invalid request" });
    }

    const orderId = "TOPUP-" + uuidv4();

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: amount,
      },
      credit_card: { secure: true },
    };

    const transaction = await snap.createTransaction(parameter);

    await db.collection("transactions").doc(orderId).set({
      uid,
      amount,
      status: "pending",
      type: "topup",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      token: transaction.token,
      redirect_url: transaction.redirect_url,
    });

  } catch (error) {
    logger.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/* ================= MIDTRANS WEBHOOK ================= */
app.post("/api/midtrans/webhook", async (req, res) => {
  try {
    const {
      order_id,
      status_code,
      gross_amount,
      signature_key,
      transaction_status
    } = req.body;

    const serverKey = process.env.MIDTRANS_SERVER_KEY;

    const hash = crypto
      .createHash("sha512")
      .update(order_id + status_code + gross_amount + serverKey)
      .digest("hex");

    if (hash !== signature_key) {
      return res.status(403).json({ message: "Invalid signature" });
    }

    if (transaction_status === "settlement" || transaction_status === "capture") {
      await db.collection("transactions").doc(order_id).update({
        status: "success",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    if (transaction_status === "expire") {
      await db.collection("transactions").doc(order_id).update({
        status: "expired",
      });
    }

    res.status(200).json({ message: "Webhook processed" });

  } catch (error) {
    logger.error(error);
    res.status(500).json({ message: "Webhook error" });
  }
});

/* ================= WITHDRAW REQUEST ================= */
app.post("/api/withdraw", async (req, res) => {
  try {
    const { uid, amount, bankAccount } = req.body;

    if (!uid || !amount || !bankAccount) {
      return res.status(400).json({ message: "Invalid request" });
    }

    const withdrawId = "WD-" + uuidv4();

    await db.collection("withdrawals").doc(withdrawId).set({
      uid,
      amount,
      bankAccount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      message: "Withdraw request submitted",
      withdrawId,
    });

  } catch (error) {
    logger.error(error);
    res.status(500).json({ message: "Withdraw error" });
  }
});

/* ================= 404 HANDLER ================= */
app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: "Route not found"
  });
});

/* ================= GLOBAL ERROR HANDLER ================= */
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({
    status: "error",
    message: "Internal Server Error"
  });
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
});

requiredEnv.forEach(env => {
  if (!process.env[env]) {
    throw new Error(`Missing ENV: ${env}`);
  }
});

/* ================= FIREBASE ================= */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FB_PROJECT_ID,
    clientEmail: process.env.FB_CLIENT_EMAIL,
    privateKey: process.env.FB_PRIVATE_KEY.replace(/\\n/g, "\n")
  })
});
const db = admin.firestore();

/* ================= MIDTRANS ================= */
const snap = new midtransClient.Snap({
  isProduction: false,
  serverKey: process.env.MIDTRANS_SERVER_KEY
});

/* ================= AUTH ================= */
async function verifyToken(req, res, next) {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];
    if (!token) return res.status(401).json({ message: "Unauthorized" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ message: "Invalid Token" });
  }
}

/* ================= PAYMENT ================= */
app.post("/api/payment", verifyToken, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 10000)
      return res.status(400).json({ message: "Minimal topup 10.000" });

    const orderId = "TOP-" + uuidv4();

    const trx = await snap.createTransaction({
      transaction_details: {
        order_id: orderId,
        gross_amount: amount
      }
    });

    await db.collection("transactions").doc(orderId).set({
      uid: req.user.uid,
      amount,
      status: "pending",
      created_at: new Date()
    });

    logger.info("Payment Created: " + orderId);

    res.json(trx);

  } catch (err) {
    logger.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ================= MIDTRANS CALLBACK ================= */
app.post("/api/midtrans-callback", async (req, res) => {
  try {
    const notif = req.body;

    const hash = crypto.createHash("sha512")
      .update(
        notif.order_id +
        notif.status_code +
        notif.gross_amount +
        process.env.MIDTRANS_SERVER_KEY
      )
      .digest("hex");

    if (hash !== notif.signature_key)
      return res.status(403).send("Invalid Signature");

    const trxRef = db.collection("transactions").doc(notif.order_id);
    const trx = await trxRef.get();

    if (!trx.exists || trx.data().status === "success")
      return res.send("OK");

    if (notif.transaction_status === "settlement") {
      const userRef = db.collection("users").doc(trx.data().uid);

      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        const balance = userDoc.data().balance || 0;

        t.update(userRef, {
          balance: balance + trx.data().amount
        });

        t.update(trxRef, { status: "success" });
      });

      logger.info("Settlement Success: " + notif.order_id);
    }

    res.send("OK");

  } catch (err) {
    logger.error(err.message);
    res.status(500).send("Error");
  }
});

/* ================= WITHDRAW ================= */
app.post("/api/withdraw", verifyToken, async (req, res) => {
  try {
    const { amount, account_number } = req.body;
    const uid = req.user.uid;

    if (!amount || amount <= 0)
      return res.status(400).json({ message: "Invalid amount" });

    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    const balance = userDoc.data().balance || 0;

    if (balance < amount)
      return res.status(400).json({ message: "Saldo tidak cukup" });

    await db.runTransaction(async (t) => {
      t.update(userRef, { balance: balance - amount });

      t.set(db.collection("withdraw_requests").doc(), {
        uid,
        amount,
        account_number,
        status: "pending",
        created_at: new Date()
      });
    });

    logger.info("Withdraw Request: " + uid);

    res.json({ message: "Withdraw menunggu approval" });

  } catch (err) {
    logger.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ================= HEALTH ================= */
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    uptime: process.uptime()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info("app.rayanxweb.topup Running on " + PORT);
});
