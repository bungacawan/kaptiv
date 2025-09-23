// /api/run_scheduled_jobs.js
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const EMAIL_FROM = process.env.EMAIL_FROM || 'me';
const WORKER_SECRET = process.env.WORKER_SECRET;
const BATCH_SIZE = parseInt(process.env.JOB_BATCH_SIZE || '20', 10);
const MAX_ATTEMPTS = 5;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/* ----------------------
   Gmail helpers
   ---------------------- */
function createOAuthClient(refreshToken) {
  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return oAuth2Client;
}

/**
 * Send email via Gmail. Returns { messageId, threadId } on success.
 */
async function sendEmailViaGmail(refreshToken, fromEmail, to, subject, body_text) {
  const oAuth2Client = createOAuthClient(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  const rawLines = [
    `From: ${fromEmail}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body_text || ''
  ];
  const raw = Buffer.from(rawLines.join('\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });

  // Gmail send returns data.id and data.threadId
  return { messageId: res?.data?.id || null, threadId: res?.data?.threadId || null };
}

/**
 * Check if recipient has replied in the given thread *after* sinceTimestamp (ms).
 * Returns true/false.
 */
async function recipientHasReplied(refreshToken, threadId, recipientEmail, sinceTimestampMs) {
  if (!threadId) return false;
  const oAuth2Client = createOAuthClient(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  try {
    // List messages in that thread (we limit to avoid large loops)
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: `in:inbox threadId:${threadId}`,
      maxResults: 20
    });

    const messages = listRes.data.messages || [];
    for (const m of messages) {
      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'metadata',
          metadataHeaders: ['From', 'Date']
        });

        const headers = msg.data.payload?.headers || [];
        const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
        const dateHeader = headers.find(h => h.name.toLowerCase() === 'date')?.value;
        const dateMs = dateHeader ? new Date(dateHeader).getTime() : 0;

        if (fromHeader.toLowerCase().includes(recipientEmail.toLowerCase()) && dateMs > (sinceTimestampMs || 0)) {
          // Found a reply from the recipient after our last send time
          return true;
        }
      } catch (innerErr) {
        // ignore per-message errors, continue checking other messages
        console.warn('recipientHasReplied: error fetching message', m.id, innerErr?.message || innerErr);
      }
    }
  } catch (err) {
    console.warn('recipientHasReplied: error listing messages for thread', threadId, err?.message || err);
    // if listing fails, assume no reply (fail-safe), or you can choose to not schedule next step
  }
  return false;
}

/* ----------------------
   Main handler
   ---------------------- */
export default async function handler(req, res) {
  // Flexible header check: accept x-worker-secret with various casing and query param fallback
  const incomingSecret =
    (req.headers['x-worker-secret'] ||
      req.headers['X-Worker-Secret'] ||
      req.headers['x-worker-secret '] ||
      req.query?.secret)?.trim?.();

  console.log('x-worker-secret received:', incomingSecret);

  if (incomingSecret !== WORKER_SECRET) {
    console.log('Unauthorized call, incoming secret:', incomingSecret);
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1) Claim jobs atomically via your existing RPC
    const { data: claimedJobs, error: rpcError } = await supabase
      .rpc('claim_scheduled_emails', { batch_size: BATCH_SIZE });

    if (rpcError) throw rpcError;

    if (!claimedJobs || claimedJobs.length === 0) {
      return res.status(200).json({ summary: 'no jobs', claimed: 0 });
    }

    let summary = { claimed: claimedJobs.length, sent: 0, failed: 0, skipped: 0, failures: [] };

    for (const job of claimedJobs) {
      const jobId = job.id;
      try {
        // fetch credential for owner (email + refresh_token)
        const { data: cred, error: credErr } = await supabase
          .from('credentials')
          .select('email, refresh_token')
          .eq('owner_id', job.owner_id)
          .maybeSingle();

        if (credErr) throw credErr;

        if (!cred?.refresh_token) {
          // mark failed - no refresh token
          await supabase.from('scheduled_emails').update({
            status: 'failed',
            last_error: 'no_refresh_token',
            updated_at: new Date().toISOString()
          }).eq('id', jobId);

          summary.failed++;
          summary.failures.push({ id: jobId, reason: 'no refresh token' });
          continue;
        }

        // Attempt to send
        const { messageId, threadId } = await sendEmailViaGmail(
          cred.refresh_token,
          cred.email || EMAIL_FROM,
          job.to_email,
          job.subject,
          job.body_text
        );

        // Update scheduled_emails row to mark sent
        await supabase.from('scheduled_emails').update({
          status: 'sent',
          message_id: messageId || null,
          updated_at: new Date().toISOString()
        }).eq('id', jobId);

        summary.sent++;

        // --- Sequence-specific post-send logic (if applicable) ---
        if (job.sequence_run_id && job.step_id) {
          try {
            // 1) Insert email_event
            await supabase.from('email_events').insert([{
              sequence_run_id: job.sequence_run_id,
              step_id: job.step_id,
              message_id: messageId || null,
              status: 'sent',
              sent_at: new Date().toISOString(),
              created_at: new Date().toISOString()
            }]);

            // 2) Find the step_order for this step
            const { data: stepRow, error: stepErr } = await supabase
              .from('sequence_steps')
              .select('step_order, sequence_id')
              .eq('id', job.step_id)
              .maybeSingle();
            if (stepErr) throw stepErr;
            const currentStepOrder = stepRow?.step_order || null;
            const sequenceId = stepRow?.sequence_id || null;

            // 3) Update sequence_runs: set current_step, thread_id (if not present), last_sent_at
            await supabase.from('sequence_runs').update({
              current_step: currentStepOrder,
              thread_id: (threadId ? threadId : undefined),
              last_sent_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }).eq('id', job.sequence_run_id);

            // 4) Check for reply - use last_sent_at as sinceTimestamp
            const { data: runRow, error: runErr } = await supabase
              .from('sequence_runs')
              .select('recipient_email, last_sent_at, thread_id, owner_id')
              .eq('id', job.sequence_run_id)
              .maybeSingle();
            if (runErr) throw runErr;

            const sinceMs = runRow?.last_sent_at ? new Date(runRow.last_sent_at).getTime() : Date.now();
            const recipientEmail = runRow?.recipient_email;
            const runThreadId = runRow?.thread_id || threadId || null;

            const replied = await recipientHasReplied(cred.refresh_token, runThreadId, recipientEmail, sinceMs);

            if (replied) {
              // mark run stopped
              await supabase.from('sequence_runs').update({
                status: 'stopped',
                updated_at: new Date().toISOString()
              }).eq('id', job.sequence_run_id);
              console.log(`Sequence run ${job.sequence_run_id} stopped due to reply from ${recipientEmail}`);
              // don't schedule next step
              continue;
            }

            // 5) Find next step (step_order > currentStepOrder)
            if (sequenceId != null && currentStepOrder != null) {
              const { data: nextStep, error: nextStepErr } = await supabase
                .from('sequence_steps')
                .select('id, step_order, subject, body_text, delay_days')
                .eq('sequence_id', sequenceId)
                .gt('step_order', currentStepOrder)
                .order('step_order', { ascending: true })
                .limit(1)
                .maybeSingle();

              if (nextStepErr) throw nextStepErr;

              if (nextStep) {
                // compute scheduled_for = now + delay_days
                const delayDays = Number(nextStep.delay_days || 0);
                const scheduledFor = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000).toISOString();

                // Insert next scheduled_emails row
                const { data: newJob, error: newJobErr } = await supabase.from('scheduled_emails')
                  .insert([{
                    owner_id: job.owner_id,
                    to_email: recipientEmail,
                    subject: nextStep.subject,
                    body_text: nextStep.body_text,
                    scheduled_for: scheduledFor,
                    timezone: job.timezone || 'Asia/Singapore',
                    status: 'scheduled',
                    attempts: 0,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    sequence_run_id: job.sequence_run_id,
                    step_id: nextStep.id
                  }])
                  .select()
                  .single();

                if (newJobErr) throw newJobErr;
                console.log('Scheduled next step for run', job.sequence_run_id, 'next step id', nextStep.id);
              } else {
                // no more steps -> mark sequence run completed
                await supabase.from('sequence_runs').update({
                  status: 'completed',
                  updated_at: new Date().toISOString()
                }).eq('id', job.sequence_run_id);
                console.log('Sequence run completed', job.sequence_run_id);
              }
            }
          } catch (seqErr) {
            console.error('sequence post-send error for job', jobId, seqErr);
            // we don't propagate to outer try: job already marked sent; record issue in last_error?
            await supabase.from('email_events').insert([{
              sequence_run_id: job.sequence_run_id,
              step_id: job.step_id,
              message_id: messageId || null,
              status: 'failed',
              last_error: String(seqErr?.message || seqErr).slice(0, 1000),
              sent_at: new Date().toISOString(),
              created_at: new Date().toISOString()
            }]).catch(() => {});
          }
        } // end sequence-specific logic

      } catch (err) {
        // on failure: backoff or fail
        try {
          const attempts = job.attempts || 1;
          if (attempts < MAX_ATTEMPTS) {
            const backoffMs = Math.pow(2, attempts) * 60 * 1000;
            const nextRun = new Date(Date.now() + backoffMs).toISOString();

            await supabase.from('scheduled_emails').update({
              status: 'scheduled',
              scheduled_for: nextRun,
              last_error: String(err?.message || err).slice(0, 1000),
              attempts: attempts + 1,
              updated_at: new Date().toISOString()
            }).eq('id', jobId);
          } else {
            await supabase.from('scheduled_emails').update({
              status: 'failed',
              last_error: String(err?.message || err).slice(0, 1000),
              attempts: (job.attempts || 1) + 1,
              updated_at: new Date().toISOString()
            }).eq('id', jobId);
          }
        } catch (innerErr) {
          console.error('Failed to update job after error', jobId, innerErr);
        }

        summary.failed++;
        summary.failures.push({ id: jobId, message: String(err?.message || err) });
      }
    } // end for each job

    return res.status(200).json({ summary });
  } catch (err) {
    console.error('run_scheduled_jobs error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
