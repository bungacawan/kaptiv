// /api/start_sequence.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const KAPTIV_API_KEY = process.env.KAPTIV_API_KEY; // a simple API key to protect this endpoint
const DEFAULT_TIMEZONE = 'Asia/Singapore';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Validate incoming payload
function validatePayload(body) {
  if (!body) return 'Missing body';
  if (!body.sequence_id) return 'Missing sequence_id';
  if (!body.owner_id) return 'Missing owner_id';
  // recipients optional (can be fetched from sequence_recipients)
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Basic API key protection (Bubble should send kaptiv_api_key header)
  const incomingKey = (req.headers['kaptiv_api_key'] || req.headers['Kaptiv-Api-Key'] || '').trim();
  if (incomingKey !== KAPTIV_API_KEY) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body || {};
  const validationErr = validatePayload(body);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const { sequence_id, owner_id, recipients, first_send_time, timezone } = body;
  const tz = timezone || DEFAULT_TIMEZONE;
  const scheduledBase = first_send_time ? new Date(first_send_time) : new Date();

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
    let finalRecipients = Array.isArray(recipients) && recipients.length ? recipients : [];
    if (finalRecipients.length === 0) {
      const { data: recRows, error: recErr } = await supabase
        .from('sequence_recipients')
        .select('email')
        .eq('sequence_id', sequence_id);
      if (recErr) throw recErr;
      finalRecipients = (recRows || []).map(r => r.email);
    }
    if (!finalRecipients.length) return res.status(400).json({ error: 'no recipients found' });

    const createdRuns = [];
    const createdJobs = [];

    // 3) For each recipient, create sequence_run and schedule first step
    for (const email of finalRecipients) {
      // create sequence_run
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

      // schedule first step
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
