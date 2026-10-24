/**
 * Reading sign-in codes on a local run: the local server mails them to
 * scripts/qa/smtp-sink.mjs, which writes each message to test-results/qa/mail.
 * (On staging the codes go to the owner's mailbox and are read by the
 * signin-staging tooling, never by a spec.)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { blocked } from "./record";
import { IS_LOCAL } from "./target";

const MAIL_DIR = process.env.QA_MAIL_DIR ?? join("test-results", "qa", "mail");

/** Decodes quoted-printable soft breaks and =XX escapes, enough to find a code. */
function decode(text: string) {
  return text.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Messages to `to` received after `since` (ms epoch), newest first. */
export function messagesTo(to: string, since: number) {
  if (!existsSync(MAIL_DIR)) return [];
  const needle = to.toLowerCase();
  return readdirSync(MAIL_DIR)
    .filter((f) => f.endsWith(".eml") && f.includes(needle.replace(/[^a-z0-9@.+-]/gi, "_")))
    .map((f) => ({ file: join(MAIL_DIR, f), at: Number(f.split("-")[0]) || statSync(join(MAIL_DIR, f)).mtimeMs }))
    .filter((m) => m.at >= since)
    .sort((a, b) => b.at - a.at)
    .map((m) => ({ ...m, body: decode(readFileSync(m.file, "utf8")) }));
}

/** Waits for the newest sign-in code mailed to `to` after `since`. */
export async function waitForCode(to: string, since: number, timeoutMs = 30_000): Promise<string> {
  if (!IS_LOCAL) blocked("reading mailed codes is for local runs (the local mail catcher)");
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const m of messagesTo(to, since)) {
      const code = m.body.match(/\b(\d{4,8})\b(?=[^\d]*(?:is your|code|expires|valid))/i)?.[1] ?? m.body.match(/code[^\d]{0,40}(\d{4,8})/i)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  blocked(`no sign-in code reached the local mail catcher for ${to} within ${timeoutMs / 1000} s (is scripts/qa/smtp-sink.mjs running and AUTH_EMAIL_SERVER set?)`);
}
