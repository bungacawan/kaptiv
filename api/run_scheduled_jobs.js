// /api/run_scheduled_jobs.js
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

/**
 * Note:
 * - We DO NOT create the Supabase client at module scope because missing env vars will
 *   crash module initialization (that's what produced `supabaseKey is required.`).
 * - Instead we create the client inside the handler after verifying secrets and env presence.
 */

const BUBBLE_APP_NAME = process.env.BUBBLE_APP_NAME; // e.g. "test-2-16999"
const KAPTIV_API_KEY = process.env.KAPTIV_API_KEY;   // your Bubble API key
const EMAIL_FROM = process.env.EMAIL_FROM || "hello@yourdomain.com"; // default sender
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || "3"); // default: 3 retries
const WORKER_SECRET = process.env.WORKER_SECRET; // expected value for x-worker-secret header

export default async function handler(req, res) {
  // Only allow GET (cron-jobs.org sent GET per your first message)
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Validate x-worker-secret header (case-insensitive)
  const headerSecret =
    req.headers["x-worker-secret"] ||
    req.headers["X-Worker-Secret"] ||
    req.headers["x-worker-secret".toLowerCase()];

  if (!WORKER_SECRET || headerSecret !== WORKER_SECRET) {
    // Do not reveal whether WORKER_SECRET is configured
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // Read env vars (supporting a common misspelling fallback)
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.SUPABASEURL ?? process.env.SUP_BASE_URL;
  // Accept either SUPABASE_SERVICE_ROLE_KEY (normal) or SUPBASE_SERVICE_KEY (your current var)
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPBASE_SERVICE_KEY ??
    process.env.SUPABASE_KEY;

  // Sanity check env presence (log boolean only)
  console.log("Supabase URL present?", Boolean(supabaseUrl));
  console.log("Supabase key present?", Boolean(supabaseKey));

  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing Supabase environment variables (SUPABASE_URL or service role key).");
    return res.status(500).json({
      ok: false,
      error: "Missing Supabase environment variables",
    });
  }

  // Create the Supabase client now that we know env vars exist and the request is authorized
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // 1. Fetch pending scheduled emails whose send_time <= now
    const nowIso = new Date().toISOString();
    const { data: scheduledEmails, error } = await supabase
      .from("schedule_emails")
      .select("*")
      .eq("status", "pending")
      .lte("send_time", nowIso);

    if (error) {
      console.error("Supabase select error:", error);
      throw error;
    }

    if (!scheduledEmails || scheduledEmails.length === 0) {
      return res.status(200).json({ ok: true, message: "No emails to send." });
    }

    // 2. Process each email
    for (const email of scheduledEmails) {
      try {
        console.log(`📨 Sending email to ${email.to_email} (id=${email.id})...`);

        const bubbleEndpoint = `https://${BUBBLE_APP_NAME}.bubbleapps.io/version-test/api/1.1/wf/send_email`;
        const bubbleResponse = await fetch(bubbleEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${KAPTIV_API_KEY}`
          },
          body: JSON.stringify({
            to: email.to_email,
            subject: email.subject,
            body: email.email_body,
            from: EMAIL_FROM
          }),
        });

        let result;
        try {
          result = await bubbleResponse.json();
        } catch (parseErr) {
          // If Bubble returns non-JSON, capture text for debugging
          const text = await bubbleResponse.text().catch(() => "");
          throw new Error(`Bubble responded with non-JSON: ${text}`);
        }

        if (bubbleResponse.ok && (result.status === "success" || result.success === true)) {
          await supabase
            .from("schedule_emails")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", email.id);

          console.log(`✅ Sent to ${email.to_email} (id=${email.id})`);
        } else {
          // Bubble reported failure
          const msg = result?.message || result?.error || "Failed to send";
          throw new Error(msg);
        }

      } catch (sendError) {
        console.error(`❌ Failed to send to ${email.to_email} (id=${email.id}):`, sendError.message);

        const newAttempts = (email.attempts || 0) + 1;
        const status = newAttempts >= MAX_ATTEMPTS ? "failed" : "pending";

        await supabase
          .from("schedule_emails")
          .update({ status, attempts: newAttempts })
          .eq("id", email.id);
      }
    }

    return res.status(200).json({ ok: true, processed: scheduledEmails.length });
  } catch (err) {
    console.error("🚨 Error running scheduled jobs:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
}
