// start_sequence.js
// Node/Express + supabase-js. Drop into your project and deploy.
// npm i express @supabase/supabase-js

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Expect these env vars
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // server-only service role key
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

/**
 * POST /start_sequence
 * Expected body (recommended):
 * {
 *   "sequence_id": "<sequence_id>",
 *   "current_users_unique_id": "<owner id>",
 *   "recipients": ["a@x.com","b@y.com"]   // or a string "a@x.com,b@y.com" or '["a@","b@"]'
 * }
 */
app.post('/start_sequence', async (req, res) => {
  try {
    console.log('=== /start_sequence RAW BODY ===');
    console.log(JSON.stringify(req.body, null, 2));

    // ---------- Normalize recipients ----------
    let raw = req.body && req.body.recipients;
    let recipients = [];

    if (!raw) raw = [];

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      // If JSON stringified array -> parse
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) recipients = parsed;
        else if (typeof parsed === 'string') {
          // single string inside quotes -> split
          recipients = parsed.split(',').map(s => s.trim()).filter(Boolean);
        }
      } catch (e) {
        // not JSON -> split by comma
        recipients = trimmed.split(',').map(s => s.trim()).filter(Boolean);
      }
    } else if (Array.isArray(raw)) {
      recipients = raw;
    } else {
      // maybe array of objects
      try {
        recipients = Array.from(raw);
      } catch (e) {
        recipients = [];
      }
    }

    // If array of objects with email fields -> map to emails
    if (recipients.length && typeof recipients[0] === 'object') {
      recipients = recipients.map(r => (r && (r.email || r.address || r.email_address)) || null).filter(Boolean);
    }

    // Normalize strings + dedupe (preserve order)
    const seen = new Set();
    recipients = recipients
      .map(r => String(r || '').trim())
      .filter(Boolean)
      .filter(r => {
        const k = r.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    console.log('Normalized recipients:', recipients);

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'no recipients after normalization', raw: req.body.recipients });
    }

    // ---------- Required metadata ----------
    const sequence_id = req.body.sequence_id || null; // optional, used for jobs/steps linking
    const owner_id = req.body.current_users_unique_id || req.body.owner_id || null;

    // ---------- Create sequence_run rows (one per recipient) ----------
    // Adjust columns to match your schema. Example columns used:
    // id (uuid), sequence_id, recipient_email, owner_id, current_step, status, created_at
    const now = new Date().toISOString();
    const sequenceRuns = recipients.map(email => ({
      sequence_id: sequence_id,
      recipient_email: email,
      owner_id: owner_id,
      current_step: 0,
      status: 'active',
      created_at: now,
      updated_at: now
    }));

    // Insert (or upsert to avoid duplicates). Change onConflict keys to your table's unique constraint.
    const { data: runsData, error: runsError } = await supabase
      .from('sequence_runs')
      .upsert(sequenceRuns, { onConflict: ['sequence_id', 'recipient_email'] }); // change keys if needed

    if (runsError) {
      console.error('Error upserting sequence_runs:', runsError);
      return res.status(500).json({ error: 'supabase_sequence_runs_error', detail: runsError });
    }

    console.log('sequence_runs upserted count:', runsData ? runsData.length : 0);

    // Map created run ids back to recipients if available
    // Note: supabase upsert returns the rows (if allowed)
    const runIdsByEmail = {};
    if (Array.isArray(runsData)) {
      runsData.forEach(r => {
        if (r && r.recipient_email) runIdsByEmail[r.recipient_email.toLowerCase()] = r.id;
      });
    }

    // ---------- Insert / upsert into sequence_recipient (if you use this table) ----------
    // Adjust columns to match your schema: sequence_run_id, sequence_id, email, owner_id, created_at
    const recipientRows = recipients.map(email => ({
      sequence_run_id: runIdsByEmail[email.toLowerCase()] || null,
      sequence_id: sequence_id,
      email,
      owner_id,
      created_at: now
    }));

    const { data: recData, error: recError } = await supabase
      .from('sequence_recipient')
      .upsert(recipientRows, { onConflict: ['sequence_run_id', 'email'] }); // change to your unique keys

    if (recError) {
      console.error('Error upserting sequence_recipient:', recError);
      // Not fatal necessarily—return error for debugging
      return res.status(500).json({ error: 'supabase_sequence_recipient_error', detail: recError });
    }

    console.log('sequence_recipient upserted count:', recData ? recData.length : 0);

    // ---------- Optionally: schedule jobs / create job rows (example) ----------
    // If your helper schedules emails (jobs) per step, handle that here. Example omitted.

    // ---------- Success response ----------
    return res.status(200).json({
      ok: true,
      runs: runsData || [],
      sequence_recipient: recData || []
    });

  } catch (err) {
    console.error('Unhandled error in /start_sequence:', err);
    return res.status(500).json({ error: 'internal_error', detail: String(err) });
  }
});

// If running standalone (node start_sequence.js)
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`start_sequence listening on ${port}`));
}

module.exports = app;
