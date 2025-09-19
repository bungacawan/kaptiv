// index.js - Kaptiv Gmail OAuth helper + send_email with persistent storage (Supabase)
import express from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { sendEmailViaGmail } from "./gmailHelper.js";

const app = express();
app.use(express.json());

// ENV vars (set these in Vercel)
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // e.g., https://kaptiv-eight.vercel.app/oauth2/callback
const KAPTIV_API_KEY = process.env.KAPTIV_API_KEY;
const FRONTEND_RETURN = process.env.FRONTEND_RETURN || "https://kaptiv.io/gmail-connected";

// Supabase client (server-side)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("Supabase env vars not set. Please set SUPABASE_URL and SUPABASE_SERVICE_KEY.");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// In-memory state store for OAuth state -> owner_id mapping (temporary)
const stateStore = new Map(); // state -> { owner_id, return_url, expires_at }

// Helper middleware: require API key in Authorization header
function requireApiKey(req, res, next) {
  const auth = (req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.split(" ")[1] : null;
  if (!token || token !== KAPTIV_API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// POST /oauth/start
app.post("/oauth/start", requireApiKey, (req, res) => {
  try {
    const { owner_id, return_url } = req.body || {};
    if (!owner_id) return res.status(400).json({ ok: false, error: "owner_id required" });

    const state = uuidv4();
    stateStore.set(state, {
      owner_id,
      return_url: return_url || FRONTEND_RETURN,
      expires_at: Date.now() + 1000 * 60 * 15
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
        grant_type: "authorization_code"
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { refresh_token, id_token } = tokenRes.data;

    // Extract email from id_token
    let email = null;
    if (id_token) {
      try {
        const payload = JSON.parse(Buffer.from(id_token.split(".")[1], "base64").toString());
        email = payload.email || null;
      } catch (e) {
        console.warn("Failed to decode id_token:", e?.message || e);
      }
    }

    // Persist to Supabase
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      console.warn("Skipping persistence: SUPABASE not configured.");
    } else {
      const upsert = {
        owner_id: entry.owner_id,
        email: email || null,
        refresh_token: refresh_token || null,
        created_at: new Date().toISOString()
      };
      const { error } = await supabase.from("credentials").upsert(upsert, { onConflict: "owner_id" });
      if (error) {
        console.error("Supabase upsert error:", error);
        // continue — we still redirect but warn
      } else {
        console.log("Persisted credential for owner:", entry.owner_id, { email, hasRefresh: !!refresh_token });
      }
    }

    // Redirect back to Bubble frontend
    const redirectBack = entry.return_url || FRONTEND_RETURN;
    const url = redirectBack + (redirectBack.includes("?") ? "&" : "?") + `status=success&owner_id=${encodeURIComponent(entry.owner_id)}`;
    return res.redirect(url);
  } catch (err) {
    console.error("oauth callback error:", err.response?.data || err.message || err);
    return res.status(500).send("OAuth callback error. Check server logs.");
  }
});

// GET /status
app.get("/status", requireApiKey, async (req, res) => {
  const owner_id = req.query.owner_id;
  if (!owner_id) return res.status(400).json({ ok: false, error: "owner_id required" });

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.json({ ok: true, connected: false });
    }
    const { data, error } = await supabase.from("credentials").select("refresh_token, email, created_at").eq("owner_id", owner_id).maybeSingle();
    if (error) {
      console.error("Supabase read error:", error);
      return res.status(500).json({ ok: false, error: "db_error" });
    }
    if (!data) return res.json({ ok: true, connected: false });
    return res.json({ ok: true, connected: !!data.refresh_token, email: data.email, created_at: data.created_at });
  } catch (err) {
    console.error("status error:", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// POST /send_email
app.post("/send_email", requireApiKey, async (req, res) => {
  try {
    const { owner_id, to, subject, body_text } = req.body || {};
    if (!owner_id || !to) return res.status(400).json({ ok: false, error: "owner_id and to required" });

    // read credential from Supabase
    const { data, error } = await supabase.from("credentials").select("refresh_token, email").eq("owner_id", owner_id).maybeSingle();
    if (error) {
      console.error("Supabase read error:", error);
      return res.status(500).json({ ok: false, error: "db_error" });
    }
    const refreshToken = data?.refresh_token || null;
    if (!refreshToken) return res.status(400).json({ ok: false, error: "No Gmail connected for this user" });

    const messageId = await sendEmailViaGmail(refreshToken, to, subject || "(no subject)", body_text || "");
    // optional: update last_used_at
    await supabase.from("credentials").update({ last_used_at: new Date().toISOString() }).eq("owner_id", owner_id);

    return res.json({ ok: true, message_id: messageId });
  } catch (err) {
    console.error("send_email error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ ok: false, error: "send_error", detail: err?.message });
  }
});

// ESM-safe local start
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
if (process.env.NODE_ENV === "development" || process.env.RUN_LOCAL === "true") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server listening on port ${port}`));
}

export default app;
