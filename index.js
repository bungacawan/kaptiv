// index.js - Kaptiv Gmail OAuth helper + send_email endpoint
// DEV notes: uses in-memory stores for quick testing. Replace with a persistent DB + KMS encryption in production.

import express from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

import { sendEmailViaGmail } from "./gmailHelper.js"; // must exist in same folder

const app = express();
app.use(express.json());

// ENV vars (set these in Vercel)
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // e.g. https://kaptiv-eight.vercel.app/oauth2/callback
const KAPTIV_API_KEY = process.env.KAPTIV_API_KEY;
const FRONTEND_RETURN = process.env.FRONTEND_RETURN || "https://kaptiv.io/gmail-connected";

// DEV: in-memory stores. Replace with DB+encryption for production.
const stateStore = new Map();      // state -> { owner_id, return_url, expires_at }
const credentialStore = new Map(); // owner_id -> { email, refresh_token, created_at }

// Helper middleware: require API key in Authorization header
function requireApiKey(req, res, next) {
  const auth = (req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.split(" ")[1] : null;
  if (!token || token !== KAPTIV_API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// =================
// POST /oauth/start
// Starts OAuth flow — returns auth_url and state.
// Body: { owner_id: "<kaptiv-user-id>", return_url: "https://kaptiv.io/gmail-connected" (optional) }
// =================
app.post("/oauth/start", requireApiKey, (req, res) => {
  try {
    const { owner_id, return_url } = req.body || {};
    if (!owner_id) return res.status(400).json({ ok: false, error: "owner_id required" });

    const state = uuidv4();
    stateStore.set(state, {
      owner_id,
      return_url: return_url || FRONTEND_RETURN,
      expires_at: Date.now() + 1000 * 60 * 15 // 15 minutes TTL
    });

    const scope = encodeURIComponent("https://www.googleapis.com/auth/gmail.send openid email profile");
    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&response_type=code&scope=${scope}` +
      `&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;

    return res.json({ ok: true, auth_url: authUrl, state });
  } catch (err) {
    console.error("oauth/start error:", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// =================
// GET /oauth2/callback
// Google redirects here with ?code=...&state=...
// Exchanges code for tokens and stores refresh_token (DEV: in-memory).
// =================
app.get("/oauth2/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state.");

    const entry = stateStore.get(state);
    if (!entry) return res.status(400).send("Invalid or expired state.");
    stateStore.delete(state);

    // Exchange authorization code for tokens
    const tokenRes = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code"
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { refresh_token, id_token } = tokenRes.data;

    // Extract email from id_token (if available)
    let email = null;
    if (id_token) {
      try {
        const payload = JSON.parse(Buffer.from(id_token.split(".")[1], "base64").toString());
        email = payload.email || null;
      } catch (e) {
        console.warn("Failed to decode id_token:", e?.message || e);
      }
    }

    // Store refresh_token (DEV: in-memory; do not log token value)
    credentialStore.set(entry.owner_id, {
      email,
      refresh_token: refresh_token || null,
      created_at: new Date().toISOString()
    });

    console.log("Stored credential for owner:", entry.owner_id, { email, hasRefresh: !!refresh_token });

    // Redirect back to Bubble frontend
    const redirectBack = entry.return_url || FRONTEND_RETURN;
    const url = redirectBack + (redirectBack.includes("?") ? "&" : "?") + `status=success&owner_id=${encodeURIComponent(entry.owner_id)}`;
    return res.redirect(url);
  } catch (err) {
    console.error("oauth callback error:", err.response?.data || err.message || err);
    return res.status(500).send("OAuth callback error. Check server logs.");
  }
});

// =================
// GET /status
// Optional: Bubble can call this (with API key) to confirm connection and get connected email
// Query: ?owner_id=...
// =================
app.get("/status", requireApiKey, (req, res) => {
  const owner_id = req.query.owner_id;
  if (!owner_id) return res.status(400).json({ ok: false, error: "owner_id required" });
  const cred = credentialStore.get(owner_id);
  if (!cred) return res.json({ ok: true, connected: false });
  return res.json({ ok: true, connected: true, email: cred.email, created_at: cred.created_at });
});

// =================
// POST /send_email
// Body: { owner_id, to, subject, body_text }
// Uses stored refresh_token for owner_id and calls gmailHelper.sendEmailViaGmail
// =================
app.post("/send_email", requireApiKey, async (req, res) => {
  try {
    const { owner_id, to, subject, body_text } = req.body || {};
    if (!owner_id || !to) return res.status(400).json({ ok: false, error: "owner_id and to required" });

    console.log("send_email request:", { owner_id, to, subject });

    const refreshToken = credentialStore.get(owner_id)?.refresh_token;
    console.log("credentialStore has owner:", credentialStore.has(owner_id), "hasRefresh:", !!refreshToken);

    if (!refreshToken) return res.status(400).json({ ok: false, error: "No Gmail connected for this user" });

    const messageId = await sendEmailViaGmail(refreshToken, to, subject || "(no subject)", body_text || "");
    return res.json({ ok: true, message_id: messageId });
  } catch (err) {
    console.error("send_email error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ ok: false, error: "send_error", detail: err?.message });
  }
});

// =================
// ESM-safe local server start (Vercel will import the app; local dev can set NODE_ENV=development or RUN_LOCAL=true)
// =================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (process.env.NODE_ENV === "development" || process.env.RUN_LOCAL === "true") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server listening on port ${port}`));
}

export default app;
