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

/** Decodes quoted-printable soft breaks and =XX escapes as UTF-8 bytes (Hindi text and "—" stay intact). */
function decode(text: string) {
  const soft = text.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const hex = soft.slice(i + 1, i + 3);
    if (soft[i] === "=" && /^[0-9A-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(...Buffer.from(soft[i], "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
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
      // The same inbox gets "1234 is your delivery code for order …": only "<code> is your Gokesari
      // sign-in code" and "… email confirmation code" count, read from the subject when it has the code.
      const subject = m.body.match(/^Subject: (.*)$/im)?.[1] ?? "";
      if (/delivery code|pickup code/i.test(subject)) continue;
      const fromSubject = subject.match(/^(\d{4,8}) is your Gokesari .*code/i)?.[1];
      if (fromSubject) return fromSubject;
      const code = m.body.match(/\b(\d{4,8})\b(?=[^\d]*(?:is your|code|expires|valid))/i)?.[1] ?? m.body.match(/code[^\d]{0,40}(\d{4,8})/i)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  blocked(`no sign-in code reached the local mail catcher for ${to} within ${timeoutMs / 1000} s (is scripts/qa/smtp-sink.mjs running and AUTH_EMAIL_SERVER set?)`);
}
