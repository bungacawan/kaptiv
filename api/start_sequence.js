// /api/start_sequence.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const KAPTIV_API_KEY = process.env.KAPTIV_API_KEY; // keep this secret
const DEFAULT_TIMEZONE = 'Asia/Singapore';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing Supabase env vars');
  // If running in dev you might throw here to catch misconfig early
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Validate incoming payload
function validatePayload(body) {
  if (!body) return 'Missing body';
  if (!body.sequence_id) return 'Missing sequence_id';
  if (!body.owner_id) return 'Missing owner_id';
  // recipients optional (can be loaded from sequence_recipients)
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // raw body log for debugging (Bubble payload)
  console.log('/start_sequence RAW body:', JSON.stringify(req.body));

  // Use lowercase header key — Node lowercases all incoming header names
  const incomingKey = (req.headers['x-kaptiv-api-key'] || req.headers['kaptiv_api_key'] || '').toString().trim();
  if (!KAPTIV_API_KEY || incomingKey !== KAPTIV_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body || {};
  const validationErr = validatePayload(body);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const { sequence_id, owner_id } = body;
  let { recipients, first_send_time, timezone } = body;

  const tz = timezone || DEFAULT_TIMEZONE;

  // parse scheduled base safely
  let scheduledBase;
  if (first_send_time) {
    const parsed = new Date(first_send_time);
    if (isNaN(parsed.getTime())) {
      // not a valid date
      return res.status(400).json({ error: 'invalid first_send_time' });
    }
    scheduledBase = parsed;
  } else {
    scheduledBase = new Date();
  }

  try {
    // 1) load steps for this sequence in order
    const { data: steps, error: stepsErr } = await supabase
      .from('sequence_steps')
      .select('*')
      .eq('sequence_id', sequence_id)
      .order('step_order', { ascending: true });

    if (stepsErr) throw stepsErr;
    if (!steps || steps.length === 0) return res.status(400).json({ error: 'sequence has no steps' });

    // 2) determine recipients: use provided array OR load from sequence_recipients table
    let finalRecipients = [];
    if (Array.isArray(recipients) && recipients.length) {
      // allow recipients to be array of strings or array of { email }
      finalRecipients = recipients.map(r => (typeof r === 'string' ? r : r?.email)).filter(Boolean);
    }

    if (finalRecipients.length === 0) {
      const { data: recRows, error: recErr } = await supabase
        .from('sequence_recipients')
        .select('email')
        .eq('sequence_id', sequence_id);
      if (recErr) throw recErr;
      finalRecipients = (recRows || []).map(r => r.email).filter(Boolean);
    }

    if (!finalRecipients.length) return res.status(400).json({ error: 'no recipients found' });

    const createdRuns = [];
    const createdJobs = [];

    // 3) For each recipient, create sequence_run and schedule first step
    for (const email of finalRecipients) {
      // Prevent duplicate active run for same sequence + email
      const { data: existingRuns } = await supabase
        .from('sequence_runs')
        .select('id,status')
        .eq('sequence_id', sequence_id)
        .eq('recipient_email', email)
        .in('status', ['active', 'scheduled'])
        .limit(1);

      if (existingRuns && existingRuns.length) {
        console.log(`Skipping ${email} — existing active run found (id=${existingRuns[0].id})`);
        continue; // skip creating duplicate run
      }

      const insertRun = {
        sequence_id,
        recipient_email: email,
        owner_id,
        current_step: 0,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { data: runData, error: runErr } = await supabase
        .from('sequence_runs')
        .insert([insertRun])
        .select()
        .single();

      if (runErr) throw runErr;
      createdRuns.push(runData);

      // schedule first step (you may want to compute offsets from step metadata)
      const firstStep = steps[0];
      const scheduledForIso = new Date(scheduledBase).toISOString();

      const jobPayload = {
        owner_id,
        to_email: email,
        subject: firstStep.subject,
        body_text: firstStep.body_text,
        scheduled_for: scheduledForIso,
        timezone: tz,
        status: 'scheduled',
        attempts: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sequence_run_id: runData.id,
        step_id: firstStep.id
      };

      const { data: jobData, error: jobErr } = await supabase
        .from('scheduled_emails')
        .insert([jobPayload])
        .select()
        .single();

      if (jobErr) throw jobErr;
      createdJobs.push(jobData);
    }

    return res.status(201).json({ ok: true, runs: createdRuns, jobs: createdJobs });
  } catch (err) {
    console.error('start_sequence error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
