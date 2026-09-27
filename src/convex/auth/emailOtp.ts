import { Email } from "@convex-dev/auth/providers/Email";
import axios from "axios";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";

/**
 * SECURITY — ROTATION REQUIRED (see docs/SECURITY.md):
 * This file historically contained a hard-coded API key for the Freebuff OTP
 * delivery endpoint. The key value has been removed from source and replaced
 * with an environment read. The previously committed key must still be
 * rotated/revoked on the provider side — removal from source does not
 * invalidate it in git history.
 *
 * Self-hosting: set OTP_API_KEY in the Convex backend environment and point
 * OTP_ENDPOINT_URL at your own mail provider (see docs/DEPLOYMENT.md).
 */

export const emailOtp = Email({
  id: "email-otp",
  maxAge: 60 * 15, // 15 minutes
  // This function can be asynchronous
  async generateVerificationToken() {
    const random: RandomReader = {
      read(bytes: Uint8Array) {
        crypto.getRandomValues(bytes);
      },
    };
    const alphabet = "0123456789";
    return generateRandomString(random, alphabet, 6);
  },
  async sendVerificationRequest({ identifier: email, token }) {
    const endpoint = process.env.OTP_ENDPOINT_URL;
    const apiKey = process.env.OTP_API_KEY;
    if (!endpoint || !apiKey) {
      throw new Error(
        "OTP delivery is not configured: set OTP_ENDPOINT_URL and OTP_API_KEY in the Convex environment.",
      );
    }
    try {
      await axios.post(
        endpoint,
        {
          to: email,
          otp: token,
          appName: "Server Management Console",
        },
        {
          headers: {
            "x-api-key": apiKey,
          },
        },
      );
    } catch (error) {
      throw new Error(JSON.stringify(error));
    }
  },
});
