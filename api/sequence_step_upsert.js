// api/sequence_step_upsert.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const KAPTIV_API_KEY = process.env.KAPTIV_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// small helpers
function isValidUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}
function normalizeField(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && (v.trim() === '' || v.trim().toLowerCase() === 'null')) return null;
  return v;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // header protection (Bubble will send kaptiv_api_key header)
  const incomingKey = (req.headers['kaptiv_api_key'] || req.headers['Kaptiv-Api-Key'] || '').trim();
  if (!incomingKey || incomingKey !== KAPTIV_API_KEY) {
    console.log('Unauthorized sequence_step_upsert call, incoming key:', incomingKey);
    return res.status(401).json({ error: 'unauthorized' });
  }

  // normalize incoming JSON
  const raw = req.body || {};
  const body = {
    id: normalizeField(raw.id),
    sequence_id: normalizeField(raw.sequence_id),
    step_order: raw.step_order === undefined || raw.step_order === null ? null : Number(raw.step_order),
    subject: normalizeField(raw.subject),
    body_text: normalizeField(raw.body_text),
    delay_days: raw.delay_days === undefined || raw.delay_days === null ? 0 : Number(raw.delay_days)
  };

  // basic validation
  if (!isValidUuid(body.sequence_id)) {
    return res.status(400).json({ error: 'sequence_id must be a valid UUID' });
  }
  if (!body.subject) return res.status(400).json({ error: 'subject is required' });
  if (!body.body_text) return res.status(400).json({ error: 'body_text is required' });
  if (!Number.isFinite(body.delay_days) || body.delay_days < 0) {
    return res.status(400).json({ error: 'delay_days must be a non-negative number' });
  }
  if (body.step_order !== null && (!Number.isInteger(body.step_order) || body.step_order < 1)) {
    return res.status(400).json({ error: 'step_order must be a positive integer if provided' });
  }

  try {
    // confirm the sequence exists
    const { data: seqRow, error: seqErr } = await supabase
      .from('sequences')
      .select('id')
      .eq('id', body.sequence_id)
      .maybeSingle();
    if (seqErr) throw seqErr;
    if (!seqRow) return res.status(404).json({ error: 'sequence not found' });

    // If id provided -> update existing row (must belong to sequence)
    if (body.id) {
      if (!isValidUuid(body.id)) return res.status(400).json({ error: 'id must be a valid UUID' });

      // ensure step belongs to that sequence
      const { data: existing, error: existErr } = await supabase
        .from('sequence_steps')
        .select('id, sequence_id, step_order')
        .eq('id', body.id)
        .maybeSingle();
      if (existErr) throw existErr;
      if (!existing) return res.status(404).json({ error: 'step not found' });
      if (existing.sequence_id !== body.sequence_id) {
        return res.status(400).json({ error: 'step does not belong to the provided sequence_id' });
      }

      // update row
      const updatePayload = {
        subject: body.subject,
        body_text: body.body_text,
        delay_days: body.delay_days,
        updated_at: new Date().toISOString()
      };
      // optionally update step_order if provided
      if (body.step_order !== null) updatePayload.step_order = body.step_order;

      const { data: updated, error: updErr } = await supabase
        .from('sequence_steps')
        .update(updatePayload)
        .eq('id', body.id)
        .select()
        .single();

      if (updErr) throw updErr;
      return res.status(200).json({ ok: true, step: updated });
    }

    // INSERT path -------------------------
    // determine step_order: if not provided, append as max(step_order)+1
    let stepOrder = body.step_order;
    if (stepOrder === null) {
      // get the current highest step_order (if any)
      const { data: rows, error: rowsErr } = await supabase
        .from('sequence_steps')
        .select('step_order')
        .eq('sequence_id', body.sequence_id)
        .order('step_order', { ascending: false })
        .limit(1);

      if (rowsErr) throw rowsErr;
      const maxOrder = (rows && rows.length && rows[0].step_order) ? Number(rows[0].step_order) : 0;
      stepOrder = maxOrder + 1;
    } else {
      // If provided and already exists, do NOT auto-shift. Return helpful error so UI can re-order or pick null.
      const { data: conflict, error: conflictErr } = await supabase
        .from('sequence_steps')
        .select('id')
        .eq('sequence_id', body.sequence_id)
        .eq('step_order', stepOrder)
        .limit(1)
        .maybeSingle();
      if (conflictErr) throw conflictErr;
      if (conflict) {
        return res.status(409).json({
          error: 'step_order already exists for this sequence. Provide a different step_order or omit it to append.'
        });
      }
    }

    // finally insert
    const insertPayload = {
      sequence_id: body.sequence_id,
      step_order: stepOrder,
      subject: body.subject,
      body_text: body.body_text,
      delay_days: body.delay_days,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: newStep, error: insertErr } = await supabase
      .from('sequence_steps')
      .insert([insertPayload])
      .select()
      .single();

    if (insertErr) throw insertErr;
    return res.status(201).json({ ok: true, step: newStep });
  } catch (err) {
    console.error('sequence_step_upsert error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
