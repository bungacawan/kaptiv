// /api/run_scheduled_jobs.js
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI;
const EMAIL_FROM = process.env.EMAIL_FROM || 'me';
const BATCH_SIZE = parseInt(process.env.JOB_BATCH_SIZE || '20', 10);
const MAX_ATTEMPTS = 5; // change as needed

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/**
 * Sends an email using Gmail OAuth2 refresh token.
 * Assumes refreshToken belongs to the Gmail account authorized earlier.
 * Returns the messageId on success.
 */
async function sendEmailViaGmail(refreshToken, to, subject, body_text) {
  const oAuth2Client = new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GMAIL_REDIRECT_URI
  );

  oAuth2Client.setCredentials({ refresh_token: refreshToken });

  // Build raw MIME message
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

  // users.messages.send returns { data: { id: '...' } }
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

  try {
    // 1) Claim jobs atomically via the Postgres function
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
        // fetch refresh token (server-side key required)
        const { data: cred, error: credErr } = await supabase
          .from('credentials')
          .select('refresh_token')
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

        // attempt send
        const messageId = await sendEmailViaGmail(cred.refresh_token, job.to_email, job.subject, job.body_text);

        // on success update status
        await supabase.from('scheduled_emails').update({
          status: 'sent',
          message_id: messageId || null,
          updated_at: new Date().toISOString()
        }).eq('id', jobId);

        summary.sent++;
      } catch (err) {
        // on failure: either reschedule with backoff or mark failed after too many attempts
        try {
          const attempts = job.attempts || 1;
          if (attempts < MAX_ATTEMPTS) {
            // exponential backoff in minutes: base 2^attempts minutes (adjust as needed)
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
            // give up
            await supabase.from('scheduled_emails').update({
              status: 'failed',
              last_error: String(err?.message || err).slice(0, 1000),
              attempts: (job.attempts || 1) + 1,
              updated_at: new Date().toISOString()
            }).eq('id', jobId);
          }
        } catch (innerErr) {
          // If even updating the row fails, log and continue
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
