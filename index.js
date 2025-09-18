// index.js - simple server with /oauth/start and /oauth2/callback
// NOTE: This example uses in-memory stores (for dev). Replace with DB+encryption in prod.

const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// ENV vars (set these in Vercel/host)
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // e.g. https://api.kaptiv.io/oauth2/callback
const KAPTIV_API_KEY = process.env.KAPTIV_API_KEY;
const FRONTEND_RETURN = process.env.FRONTEND_RETURN || 'https://kaptiv.io/gmail-connected';

// -- In-memory stores (DEV only) --
const stateStore = new Map();      // state -> { owner_id, return_url, expires_at }
const credentialStore = new Map(); // owner_id -> { email, refresh_token, created_at }

// Helper: require API key for certain endpoints
function requireApiKey(req, res, next) {
  const auth = (req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.split(' ')[1] : null;
  if (!token || token !== KAPTIV_API_KEY) return res.status(401).json({ ok:false, error: 'unauthorized' });
  next();
}

// POST /oauth/start
// Body: { owner_id: "<kaptiv-user-id>", return_url: "https://kaptiv.io/gmail-connected" (optional) }
app.post('/oauth/start', requireApiKey, (req, res) => {
  const { owner_id, return_url } = req.body || {};
  if (!owner_id) return res.status(400).json({ ok:false, error: 'owner_id required' });

  const state = uuidv4();
  stateStore.set(state, { owner_id, return_url: return_url || FRONTEND_RETURN, expires_at: Date.now() + 1000 * 60 * 15 });

  const scope = encodeURIComponent('https://www.googleapis.com/auth/gmail.send openid email profile');
  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code&scope=${scope}` +
    `&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;

  return res.json({ ok:true, auth_url: authUrl, state });
});

// GET /oauth2/callback
// Google will redirect the browser here with ?code=...&state=...
app.get('/oauth2/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state.');

    const entry = stateStore.get(state);
    if (!entry) return res.status(400).send('Invalid or expired state.');
    stateStore.delete(state);

    // Exchange authorization code for tokens
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      }).toString(),
      { headers:{ 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, id_token } = tokenRes.data;
    if (!refresh_token) {
      // Rare: Google sometimes won't send refresh_token on repeated grants without prompt=consent,
      // but we included prompt=consent on the auth URL.
      console.warn('no refresh_token returned; ensure access_type=offline & prompt=consent');
    }

    // Extract email from id_token (simple decode)
    let email = null;
    if (id_token) {
      const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64').toString());
      email = payload.email;
    }

    // Store refresh_token securely (DEV: in-memory). Replace with DB+KMS in prod.
    credentialStore.set(entry.owner_id, { email, refresh_token, created_at: new Date().toISOString() });

    // Redirect user back to Bubble frontend or return_url
    const redirectBack = entry.return_url || FRONTEND_RETURN;
    const url = redirectBack + (redirectBack.includes('?') ? '&' : '?') + `status=success&owner_id=${encodeURIComponent(entry.owner_id)}`;
    return res.redirect(url);
  } catch (err) {
    console.error('oauth callback error', err.response?.data || err.message);
    return res.status(500).send('OAuth callback error. Check server logs.');
  }
});

// Optional: check connection status (for Bubble to poll)
app.get('/status', requireApiKey, (req, res) => {
  const owner_id = req.query.owner_id;
  if (!owner_id) return res.status(400).json({ ok:false, error:'owner_id required' });
  const cred = credentialStore.get(owner_id);
  if (!cred) return res.json({ ok:true, connected:false });
  return res.json({ ok:true, connected:true, email: cred.email, created_at: cred.created_at });
});

// For local testing: listen
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Server listening on port', port));
}

module.exports = app;
