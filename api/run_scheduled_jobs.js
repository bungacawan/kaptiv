// /api/run_scheduled_jobs.js
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

const BUBBLE_APP_NAME = process.env.BUBBLE_APP_NAME;
const KAPTIV_API_KEY = process.env.KAPTIV_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "hello@yourdomain.com";
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || "3");
const WORKER_SECRET = process.env.WORKER_SECRET;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // ✅ 1. Validate cron secret
  const headerSecret =
    req.headers["x-worker-secret"] ||
    req.headers["X-Worker-Secret"] ||
    req.headers["x-worker-secret".toLowerCase()];

  if (!WORKER_SECRET || headerSecret !== WORKER_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // ✅ 2. Load Supabase envs with correct names
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // <— FIXED HERE

  console.log("Supabase URL present?", Boolean(supabaseUrl));
  console.log("Supabase key present?", Boolean(supabaseKey));

  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing Supabase environment variables.");
    return res.status(500).json({ ok: false, error: "Missing Supabase environment variables" });
  }

  // ✅ 3. Create Supabase client inside handler
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const nowIso = new Date().toISOString();
    const { data: scheduledEmails, error } = await supabase
      .from("schedule_emails")
      .select("*")
      .eq("status", "pending")
      .lte("send_time", nowIso);

    if (error) throw error;

    if (!scheduledEmails || scheduledEmails.length === 0) {
      return res.status(200).json({ ok: true, message: "No emails to send." });
    }

    for (const email of scheduledEmails) {
      try {
        console.log(`📨 Sending email to ${email.to_email} (id=${email.id})...`);

        const bubbleEndpoint = `https://${BUBBLE_APP_NAME}.bubbleapps.io/version-test/api/1.1/wf/send_email`;
        const bubbleResponse = await fetch(bubbleEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${KAPTIV_API_KEY}`,
          },
          body: JSON.stringify({
            to: email.to_email,
            subject: email.subject,
            body: email.email_body,
            from: EMAIL_FROM,
          }),
        });

        const result = await bubbleResponse.json().catch(() => ({}));

        if (bubbleResponse.ok && (result.status === "success" || result.success === true)) {
          await supabase
            .from("schedule_emails")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", email.id);

          console.log(`✅ Sent to ${email.to_email}`);
        } else {
          throw new Error(result?.message || "Failed to send");
        }
      } catch (sendError) {
        console.error(`❌ Failed to send to ${email.to_email}:`, sendError.message);
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
    console.error("🚨 Error running scheduled jobs:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
