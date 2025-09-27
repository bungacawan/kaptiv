// /api/steps.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const KAPTIV_API_KEY = process.env.KAPTIV_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

const isUUID = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isNonEmptyString = s => typeof s === 'string' && s.trim().length > 0;
const isNonNegativeInt = n => Number.isInteger(n) && n >= 0;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Basic API key protection
  const incomingKey = (req.headers['kaptiv_api_key'] || req.headers['kaptiv-api-key'] || '').trim();
  if (!KAPTIV_API_KEY || incomingKey !== KAPTIV_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body;
  if (!body) return res.status(400).json({ error: 'Missing JSON body' });

  const sequence_id = body.sequence_id || body.sequenceId;
  if (!sequence_id || !isUUID(sequence_id)) {
    return res.status(400).json({ error: 'sequence_id missing or invalid (must be uuid)' });
  }

  // Accept either a top-level 'steps' array or single-step properties
  let steps = [];
  if (Array.isArray(body.steps)) {
    steps = body.steps;
  } else {
    // single-step fields fallback
    const maybeStep = {
      subject: body.subject,
      body_text: body.body_text || body.bodyText || body.body,
      step_order: body.step_order ?? body.stepOrder ?? 1,
      delay_days: body.delay_days ?? body.delayDays ?? 0
    };
    // If subject or body_text present, treat as one step
    if (isNonEmptyString(maybeStep.subject) || isNonEmptyString(maybeStep.body_text)) {
      steps = [maybeStep];
    }
  }

  if (!steps || steps.length === 0) {
    return res.status(400).json({ error: 'no steps provided' });
  }

  // Normalize + validate each step and attach sequence_id
  const normalized = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const step_order = Number.isInteger(s.step_order) ? s.step_order : parseInt(s.step_order) || (i + 1);
    const subject = (s.subject || '').toString().trim();
    const body_text = (s.body_text || s.bodyText || s.body || '').toString().trim();
    const delay_days = Number.isInteger(s.delay_days) ? s.delay_days : parseInt(s.delay_days) || 0;

    if (!isNonEmptyString(subject)) return res.status(400).json({ error: `step ${i+1} missing subject` });
    if (!isNonEmptyString(body_text)) return res.status(400).json({ error: `step ${i+1} missing body_text` });
    if (!isNonNegativeInt(delay_days)) return res.status(400).json({ error: `step ${i+1} invalid delay_days` });

    normalized.push({
      sequence_id,
      step_order,
      subject,
      body_text,
      delay_days,
      // optionally set id here, but let DB default from gen_random_uuid()
      // created_at/updated_at defaults can be handled by DB if you have defaults
    });
  }

  try {
    // Bulk insert all steps in one call
    const { data, error } = await supabase
      .from('sequence_steps')
      .insert(normalized)
      .select(); // select returns created rows for confirmation

    if (error) {
      console.error('supabase insert error', error);
      return res.status(500).json({ error: error.message || 'db error' });
    }

    return res.status(201).json({ ok: true, inserted: data.length, rows: data });
  } catch (err) {
    console.error('handler error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
