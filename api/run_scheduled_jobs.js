// /api/run_scheduled_jobs.js
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const BUBBLE_APP_NAME = process.env.BUBBLE_APP_NAME; // e.g. "test-2-16999"
const KAPTIV_API_KEY = process.env.KAPTIV_API_KEY;   // your Bubble API key
const EMAIL_FROM = process.env.EMAIL_FROM || "hello@yourdomain.com"; // default sender
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || "3"); // default: 3 retries

export default async function handler(req, res) {
  try {
    // 1. Fetch pending scheduled emails
    const { data: scheduledEmails, error } = await supabase
      .from("schedule_emails")
      .select("*")
      .eq("status", "pending")
      .lte("send_time", new Date().toISOString());

    if (error) throw error;

    if (!scheduledEmails || scheduledEmails.length === 0) {
      return res.status(200).json({ ok: true, message: "No emails to send." });
    }

    // 2. Process each email
    for (const email of scheduledEmails) {
      try {
        console.log(`📨 Sending email to ${email.to_email}...`);

        const bubbleResponse = await fetch(
          `https://${BUBBLE_APP_NAME}.bubbleapps.io/version-test/api/1.1/wf/send_email`,
          {
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
          }
        );

        const result = await bubbleResponse.json();

        if (bubbleResponse.ok && result.status === "success") {
          await supabase
            .from("schedule_emails")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", email.id);

          console.log(`✅ Sent to ${email.to_email}`);
        } else {
          throw new Error(result.message || "Failed to send");
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
