// gmailHelper.js
import { google } from "googleapis";

// ENV vars
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || "https://kaptiv-eight.vercel.app/oauth2/callback";

// In-memory store (DEV only) — same as index.js
import { credentialStore } from "./index.js"; // make sure you export credentialStore from index.js

// Create an OAuth2 client
function createOAuthClient() {
  return new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );
}

// Get refresh token for owner_id
export async function getRefreshToken(owner_id) {
  const cred = credentialStore.get(owner_id);
  if (!cred) throw new Error("No credentials found for this user");
  return cred.refresh_token;
}

// Send email via Gmail API
export async function sendEmailViaGmail(refreshToken, to, subject, bodyText) {
  const oAuth2Client = createOAuthClient();
  oAuth2Client.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  // Construct email message
  const messageParts = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "",
    bodyText
  ];
  const message = messageParts.join("\n");

  // Encode to base64 URL-safe
  const encodedMessage = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // Send email
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodedMessage
    }
  });

  return res.data.id; // Gmail message ID
}
