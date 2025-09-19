// index.js - server for Kaptiv Gmail OAuth + send_email
// DEV: in-memory stores. Use DB+encryption in prod.

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { sendEmailViaGmail } from "./gmailHelper.js";

const app = express();
app.use(bodyParser.json());

// ENV vars
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // e.g., https://api.kaptiv.io/oauth2/callback
const KAPTIV_API_KEY = process.env.KAPTIV_API_KEY;
const FRONTEND_RETURN = process.env.FRONTEND_RETURN || "https://kaptiv.io/gmail-connected";

// -- In-memory stores (DEV only) --
const stateStore = new Map();      // state -> { owner_id, return_url, expires_at }
const credentialStore = new Map(); // owner_id -> { email, refresh_token, created_at }

// Helper: require API key for certain endpoints
function requireApiKey(req, res, next) {
  const auth = (req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.split(" ")[1] : null;
  if (!token || token !== KAPTIV_API_KEY) return res.status(401).json({ ok:false, error: "unauthorized" });
  next();
}

// POST /oauth/start
app.post("/oauth/start", requireApiKey, (req, res) => {
  const { owner_id, return_url } = req.body || {};
  if (!owner_id) return res.status(400).json({ ok:false, error: "owner_id required" });

  const state = uuidv4();
  stateStore.set(state, { owner_id, return_url: return_url || FRONTEND_RETURN, expires_at: Date.now() + 1000 * 60 * 15 });

  const scope = encodeURIComponent("https://www.googleapis.com/auth/gmail.send openid email profile");
  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code&scope=${scope}` +
    `&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;

  return res.json({ ok:true, auth_url: authUrl, state });
});

// GET /oauth2/callback
app.get("/oauth2/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state.");

    const entry = stateStore.get(state);
    if (!entry) return res.status(400).send("Invalid or expired state.");
    stateStore.delete(state);

    // Exchange code for tokens
    const tokenRes = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { refresh_token, id_token } = tokenRes.data;

    // Extract email from id_token
    let email = null;
    if (id_token) {
      const payload = JSON.parse(Buffer.from(id_token.split(".")[1], "base64").toString());
      email = payload.email;
    }

    // Store refresh_token (DEV: in-memory)
    credentialStore.set(entry.owner_id, { email, refresh_token, created_at: new Date().toISOString() });

    // Redirect user back to Bubble frontend
    const redirectBack = entry.return_url || FRONTEND_RETURN;
    const url = redirectBack + (redirectBack.includes("?") ? "&" : "?") + `status=success&owner_id=${encodeURIComponent(entry.owner_id)}`;
    return res.redirect(url);
  } catch (err) {
    console.error("oauth callback error", err.response?.data || err.message);
    return res.status(500).send("OAuth callback error. Check server logs.");
  }
});

// GET /status - optional, Bubble can poll connection
app.get("/status", requireApiKey, (req, res) => {
  const owner_id = req.query.owner_id;
  if (!owner_id) return res.status(400).json({ ok:false, error:"owner_id required" });
  const cred = credentialStore.get(owner_id);
  if (!cred) return res.json({ ok:true, connected:false });
  return res.json({ ok:true, connected:true, email: cred.email, created_at: cred.created_at });
});

// POST /send_email - send via user's Gmail
app.post("/send_email", requireApiKey, async (req, res) => {
  try {
    const { owner_id, to, subject, body_text } = req.body;
    const refreshToken = credentialStore.get(owner_id)?.refresh_token; // DEV: in-memory
    if (!refreshToken) return res.status(400).json({ ok:false, error:"No Gmail connected for this user" });

    const messageId = await sendEmailViaGmail(refreshToken, to, subject, body_text);
    return res.json({ ok:true, message_id: messageId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, error: err.message });
  }
});

// Local testing
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("Server listening on port", port));
}

export default app;
