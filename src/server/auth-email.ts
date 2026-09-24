/**
 * Email magic-link sign-in (GS-001 — the "email" part of mobile/email/Gmail
 * login; mobile OTP waits on the SMS-provider decision D2).
 *
 * Enabled only when AUTH_EMAIL_FROM is set. With AUTH_EMAIL_SERVER (an SMTP
 * connection string) the link is mailed; without it, outside production, the
 * link is printed to the server console so the flow can be exercised locally.
 * Production with no SMTP server configured never enables the provider — a
 * sign-in button that silently mails nothing is worse than no button.
 */
import type { EmailConfig } from "next-auth/providers/email";

import { getEnv } from "@/lib/env";

export const EMAIL_PROVIDER_ID = "email";

/** Link lifetime. Short on purpose: a leaked link is a leaked session. */
const MAGIC_LINK_MAX_AGE_SECONDS = 15 * 60;

export type EmailSignInMode = "smtp" | "console" | "disabled";

export function emailSignInMode(
  env: Pick<ReturnType<typeof getEnv>, "AUTH_EMAIL_FROM" | "AUTH_EMAIL_SERVER" | "NODE_ENV"> = getEnv(),
): EmailSignInMode {
  if (!env.AUTH_EMAIL_FROM) return "disabled";
  if (env.AUTH_EMAIL_SERVER) return "smtp";
  return env.NODE_ENV === "production" ? "disabled" : "console";
}

export function magicLinkEmail(url: string): { subject: string; text: string; html: string } {
  const host = new URL(url).host;
  const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return {
    subject: `Your Gokesari sign-in link`,
    text: `Sign in to ${host}:\n${url}\n\nThis link works once and expires in 15 minutes. If you did not ask for it, ignore this email.\n`,
    html:
      `<p>Tap the button to sign in to <strong>${host}</strong>.</p>` +
      `<p><a href="${escaped}" style="display:inline-block;padding:10px 18px;background:#ea580c;color:#fff;border-radius:8px;text-decoration:none">Sign in</a></p>` +
      `<p style="color:#666;font-size:12px">This link works once and expires in 15 minutes. If you did not ask for it, ignore this email.</p>`,
  };
}

export function emailProvider(): EmailConfig | null {
  const env = getEnv();
  const mode = emailSignInMode(env);
  if (mode === "disabled") return null;

  return {
    id: EMAIL_PROVIDER_ID,
    type: "email",
    name: "Email",
    from: env.AUTH_EMAIL_FROM,
    maxAge: MAGIC_LINK_MAX_AGE_SECONDS,
    options: {},
    async sendVerificationRequest({ identifier, url }) {
      const message = magicLinkEmail(url);
      if (mode === "console") {
        console.info(`[auth] magic link for ${identifier}: ${url}`);
        return;
      }
      const { createTransport } = await import("nodemailer");
      const result = await createTransport(env.AUTH_EMAIL_SERVER).sendMail({
        to: identifier,
        from: env.AUTH_EMAIL_FROM,
        ...message,
      });
      const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
      if (failed.length) throw new Error("The sign-in email could not be sent.");
    },
  };
}
