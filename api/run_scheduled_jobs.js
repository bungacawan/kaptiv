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

/**
 * Sends an email using Gmail OAuth2 refresh token.
 * Returns the messageId on success.
 */
async function sendEmailViaGmail(refreshToken, to, subject, body_text) {
  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );

  oAuth2Client.setCredentials({ refresh_token: refreshToken });

  const rawLines = [
    `From: ${EMAIL_FROM}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body_text || ''
  ];

  const raw = Buffer.from(rawLines.join('\n')).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });

  return res?.data?.id;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Trim incoming header to handle cron-job.org quirks
  const incomingSecret = (req.headers['x-worker-secret'] || '').trim();
  console.log('x-worker-secret received:', incomingSecret);

  if (incomingSecret !== WORKER_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    // Claim jobs atomically via Supabase RPC
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
        const { data: cred, error: credErr } = await supabase
          .from('credentials')
          .select('refresh_token')
          .eq('owner_id', job.owner_id)
          .maybeSingle();

        if (credErr) throw credErr;

        if (!cred?.refresh_token) {
          await supabase.from('scheduled_emails').update({
            status: 'failed',
            last_error: 'no_refresh_token',
            updated_at: new Date().toISOString()
          }).eq('id', jobId);

          summary.failed++;
          summary.failures.push({ id: jobId, reason: 'no refresh token' });
          continue;
        }

        // Attempt send
        const messageId = await sendEmailViaGmail(cred.refresh_token, job.to_email, job.subject, job.body_text);

        // On success
        await supabase.from('scheduled_emails').update({
          status: 'sent',
          message_id: messageId || null,
          updated_at: new Date().toISOString()
        }).eq('id', jobId);

        summary.sent++;
      } catch (err) {
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
    }

    return res.status(200).json({ summary });
  } catch (err) {
    console.error('run_scheduled_jobs error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
