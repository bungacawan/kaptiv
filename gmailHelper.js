// gmailHelper.js
import { google } from "googleapis";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || "https://kaptiv-eight.vercel.app/oauth2/callback";

function createOAuthClient() {
  return new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );
}

/**
 * sendEmailViaGmail(refreshToken, to, subject, bodyText)
 * - refreshToken: string (must be passed in by index.js)
 * - returns: Gmail message ID (string)
 */
export async function sendEmailViaGmail(refreshToken, to, subject, bodyText) {
  if (!refreshToken) throw new Error("No refresh token provided to gmail helper");
  const oAuth2Client = createOAuthClient();
  oAuth2Client.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  // Build a simple RFC 2822 message (plain text). Add MIME headers if you want HTML.
  const messageParts = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    bodyText || ""
  ];
  const message = messageParts.join("\n");

  // base64url encode
  const encodedMessage = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // Send
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodedMessage
    }
  });

  return res.data?.id || res.data?.threadId || null;
}
