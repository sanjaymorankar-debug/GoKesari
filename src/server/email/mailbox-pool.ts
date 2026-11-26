/**
 * Mailbox rotation (owner, 21 Nov 2026).
 *
 * Hostinger lets each mailbox send about 100 e-mails in any 24 hours (a
 * rolling window, not from midnight). With EMAIL_POOL set, mail goes out from
 * several mailboxes in turn: the first one that has sent fewer than
 * EMAIL_POOL_DAILY_CAP (90) e-mails in the last 24 hours sends it. A mailbox
 * frees up again as its sends pass the 24-hour mark, so the rotation resets
 * itself. The AUTH_EMAIL_SERVER mailbox is the last one tried.
 *
 * Each send is counted in email_mailbox_sends (mailbox and time only), so the
 * count is shared by every server process and survives a restart. If the mail
 * server still refuses a mailbox (its limit, or a wrong password), that
 * mailbox is paused for an hour and the next one is tried at once. A problem
 * with the message itself is not retried from another mailbox.
 *
 * Without EMAIL_POOL nothing changes: every e-mail goes through
 * AUTH_EMAIL_SERVER and the table is never touched.
 */
import { and, gt, inArray, lt, sql } from "drizzle-orm";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import { getEnv, type ServerEnv } from "@/lib/env";
import { db } from "@/server/db";
import { emailMailboxSends } from "@/server/db/schema";

/** The rolling window Hostinger counts sends over. */
export const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a mailbox the server refused is left alone. */
export const REFUSAL_PAUSE_MS = 60 * 60 * 1000;
/** Rows kept for the count (and a day more to look back on); older ones are deleted hourly. */
export const SEND_LOG_RETAIN_MS = 2 * SEND_WINDOW_MS;

export interface Mailbox {
  /** The mailbox address, lower case: what sends are counted under. */
  address: string;
  /** What nodemailer connects with. */
  connection: string | SMTPTransport.Options;
  /** The From header. */
  from: string;
  /** Replies go here (the main sender address) when this is a rotation mailbox. */
  replyTo?: string;
  /** The AUTH_EMAIL_SERVER mailbox. */
  main: boolean;
}

export interface PoolMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType: string; cid?: string }[];
  /** docs/seller-agreements-2026-11: copied recipients (signed agreements → ceo@agtci.com). */
  cc?: string[];
  /** Called once the server accepted the message, with its Message-ID (the signed-agreement send log). */
  onSent?: (info: { messageId: string | null; mailbox: string }) => void;
}

type PoolEnv = Pick<ServerEnv, "AUTH_EMAIL_FROM" | "AUTH_EMAIL_SERVER" | "EMAIL_POOL" | "EMAIL_POOL_PASSWORD" | "EMAIL_POOL_DAILY_CAP">;

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** "Gokesari <no-reply@gokesari.com>" → { name: "Gokesari", address: "no-reply@gokesari.com" }. */
export function parseSender(from: string | undefined): { name: string | null; address: string | null } {
  const value = (from ?? "").trim();
  const angled = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(value);
  if (angled) return { name: angled[1].trim() || null, address: angled[2].trim() };
  return { name: null, address: EMAIL_RE.test(value) ? value : null };
}

function quoteName(name: string): string {
  return /^[\w .-]+$/.test(name) ? name : `"${name.replace(/["\\]/g, "")}"`;
}

/** The address an SMTP URL signs in as, lower case; null if it has none. */
function urlMailbox(url: string): string | null {
  try {
    const user = decodeURIComponent(new URL(url).username);
    return user ? user.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Host, port and TLS of AUTH_EMAIL_SERVER, for pool entries given as plain addresses. */
function serverOf(url: string | undefined): { host: string; port: number; secure: boolean } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^smtps?:$/.test(u.protocol) || !u.hostname) return null;
    const secure = u.protocol === "smtps:";
    return { host: u.hostname, port: u.port ? Number(u.port) : secure ? 465 : 587, secure };
  } catch {
    return null;
  }
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[email] ${message}`);
}

/**
 * The mailboxes mail is sent from, in the order they are tried: the EMAIL_POOL
 * entries, then the AUTH_EMAIL_SERVER mailbox. Just the main one when
 * EMAIL_POOL is empty. Entries that cannot be used are left out with a warning
 * (never naming a password).
 */
export function configuredMailboxes(env: PoolEnv = getEnv()): Mailbox[] {
  if (!env.AUTH_EMAIL_SERVER) return [];
  const sender = parseSender(env.AUTH_EMAIL_FROM);
  const mainAddress = urlMailbox(env.AUTH_EMAIL_SERVER) ?? sender.address?.toLowerCase() ?? "main";
  const main: Mailbox = { address: mainAddress, connection: env.AUTH_EMAIL_SERVER, from: env.AUTH_EMAIL_FROM ?? "", main: true };

  const entries = (env.EMAIL_POOL ?? "").split(/[\s,]+/).filter(Boolean);
  if (entries.length === 0) return [main];

  const name = quoteName(sender.name ?? "GoKesari");
  const replyTo = sender.address ?? undefined;
  const base = serverOf(env.AUTH_EMAIL_SERVER);
  const seen = new Set([main.address]);
  const pool: Mailbox[] = [];
  for (const entry of entries) {
    let box: Mailbox | null = null;
    if (/^smtps?:\/\//i.test(entry)) {
      const address = urlMailbox(entry);
      if (!address) warnOnce("an EMAIL_POOL entry is an SMTP URL with no mailbox name; it is skipped.");
      else box = { address, connection: entry, from: `${name} <${address}>`, replyTo, main: false };
    } else if (EMAIL_RE.test(entry)) {
      const address = entry.toLowerCase();
      if (!env.EMAIL_POOL_PASSWORD) warnOnce(`EMAIL_POOL_PASSWORD is not set, so ${address} cannot sign in; it is skipped.`);
      else if (!base) warnOnce(`AUTH_EMAIL_SERVER is not an smtp:// or smtps:// URL, so the server for ${address} is unknown; it is skipped.`);
      else
        box = {
          address,
          connection: { ...base, auth: { user: address, pass: env.EMAIL_POOL_PASSWORD } },
          from: `${name} <${address}>`,
          replyTo,
          main: false,
        };
    } else {
      warnOnce(`an EMAIL_POOL entry is neither a mailbox address nor an SMTP URL; it is skipped.`);
    }
    if (box && !seen.has(box.address)) {
      seen.add(box.address);
      pool.push(box);
    }
  }
  return [...pool, main];
}

export interface MailboxUsage {
  /** E-mails sent in the last 24 hours. */
  sent: number;
  /** When the server last refused it, within the last 24 hours. */
  lastRefusedAt: Date | null;
}

/** The mailboxes that may send now, in order: under the cap and not paused after a refusal. */
export function usableMailboxes(boxes: Mailbox[], usage: Map<string, MailboxUsage>, cap: number, now: Date = new Date()): Mailbox[] {
  return boxes.filter((box) => {
    const u = usage.get(box.address);
    if (!u) return true;
    if (u.sent >= cap) return false;
    return !u.lastRefusedAt || now.getTime() - u.lastRefusedAt.getTime() >= REFUSAL_PAUSE_MS;
  });
}

export type SendFailure = "limit" | "auth" | "connection" | "message";

const CONNECTION_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ETLS", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * Why a send failed: the mailbox's sending limit ("limit", also any other
 * temporary 4xx refusal), its sign-in ("auth"), the connection, or the
 * message itself ("message": a bad recipient or content, which another
 * mailbox would not fix).
 */
export function classifySendError(error: unknown): SendFailure {
  const e = (error ?? {}) as { code?: unknown; responseCode?: unknown; response?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const status = typeof e.responseCode === "number" ? e.responseCode : null;
  const text = `${typeof e.response === "string" ? e.response : ""} ${typeof e.message === "string" ? e.message : ""}`;
  // A message too big for the server is the message's problem, though the reply says "limit".
  if (/message size|too (large|big)|size limit/i.test(text)) return "message";
  if (/limit|quota|exceed|too many/i.test(text)) return "limit";
  if (code === "EAUTH" || status === 530 || status === 534 || status === 535) return "auth";
  if (CONNECTION_CODES.has(code) || status === 421) return "connection";
  if (status !== null && status >= 400 && status < 500) return "limit";
  return "message";
}

/** Sends and refusals per mailbox over the last 24 hours. */
export async function mailboxUsage(addresses: string[], now: Date = new Date()): Promise<Map<string, MailboxUsage>> {
  const usage = new Map<string, MailboxUsage>();
  if (addresses.length === 0) return usage;
  const rows = await db
    .select({
      mailbox: emailMailboxSends.mailbox,
      sent: sql<number>`count(*) filter (where ${emailMailboxSends.outcome} = 'SENT')`.mapWith(Number),
      lastRefusedAt: sql<Date | null>`max(${emailMailboxSends.createdAt}) filter (where ${emailMailboxSends.outcome} = 'REFUSED')`.mapWith(
        (v: unknown) => (v ? new Date(v as string) : null),
      ),
    })
    .from(emailMailboxSends)
    .where(and(inArray(emailMailboxSends.mailbox, addresses), gt(emailMailboxSends.createdAt, new Date(now.getTime() - SEND_WINDOW_MS))))
    .groupBy(emailMailboxSends.mailbox);
  for (const row of rows) usage.set(row.mailbox, { sent: row.sent, lastRefusedAt: row.lastRefusedAt });
  return usage;
}

async function record(mailbox: string, outcome: "SENT" | "REFUSED", detail?: string): Promise<void> {
  try {
    await db.insert(emailMailboxSends).values({ mailbox, outcome, detail: detail ? detail.slice(0, 300) : null });
  } catch (error) {
    // Counting is best effort: a missed row must never fail an e-mail that went out.
    console.error(`[email] could not record a ${outcome} for ${mailbox}:`, error instanceof Error ? error.message : error);
  }
}

export class MailboxesExhaustedError extends Error {
  constructor(cap: number, count: number) {
    super(`All ${count} mailboxes have sent ${cap} e-mails in the last 24 hours (or were refused in the last hour).`);
    this.name = "MailboxesExhaustedError";
  }
}

export class DeliveryFailedError extends Error {
  constructor() {
    super("The email could not be delivered.");
    this.name = "DeliveryFailedError";
  }
}

async function sendFrom(box: Mailbox, mail: PoolMail): Promise<void> {
  const { createTransport } = await import("nodemailer");
  const transport = typeof box.connection === "string" ? createTransport(box.connection) : createTransport(box.connection);
  const result = await transport.sendMail({
    from: box.from,
    ...(box.replyTo ? { replyTo: box.replyTo } : {}),
    to: mail.to,
    ...(mail.cc?.length ? { cc: mail.cc } : {}),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    ...(mail.attachments?.length
      ? { attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, ...(a.cid ? { cid: a.cid } : {}) })) }
      : {}),
  });
  const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
  if (failed.length) throw new DeliveryFailedError();
  mail.onSent?.({ messageId: typeof result.messageId === "string" ? result.messageId : null, mailbox: box.address });
}

/**
 * Sends one e-mail over SMTP: through AUTH_EMAIL_SERVER when EMAIL_POOL is
 * empty (as before), otherwise from the first mailbox with room, moving on to
 * the next when the server refuses one. Returns the mailbox used.
 */
export async function sendThroughMailboxes(mail: PoolMail, env: PoolEnv = getEnv(), now: Date = new Date()): Promise<string> {
  const boxes = configuredMailboxes(env);
  if (boxes.length === 0) throw new Error("Email delivery is not configured.");
  if (boxes.length === 1) {
    await sendFrom(boxes[0], mail);
    return boxes[0].address;
  }

  let usage = new Map<string, MailboxUsage>();
  try {
    usage = await mailboxUsage(
      boxes.map((b) => b.address),
      now,
    );
  } catch (error) {
    // Without the counts, try the mailboxes in order; the server's own refusals still move us on.
    console.error("[email] could not read the mailbox counts; trying the mailboxes in order:", error instanceof Error ? error.message : error);
  }
  const cap = env.EMAIL_POOL_DAILY_CAP ?? 90;
  const usable = usableMailboxes(boxes, usage, cap, now);
  if (usable.length === 0) {
    const error = new MailboxesExhaustedError(cap, boxes.length);
    console.error(`[email] ${error.message} Add mailboxes to EMAIL_POOL.`);
    throw error;
  }

  let lastError: unknown = null;
  for (const box of usable) {
    try {
      await sendFrom(box, mail);
    } catch (error) {
      const kind = classifySendError(error);
      if (kind === "message") throw error;
      lastError = error;
      const detail = (error as { response?: unknown }).response;
      if (kind === "limit" || kind === "auth") {
        await record(box.address, "REFUSED", `${kind}: ${typeof detail === "string" ? detail : error instanceof Error ? error.message : ""}`);
      }
      console.warn(`[email] ${box.address} could not send (${kind}); trying the next mailbox.`);
      continue;
    }
    await record(box.address, "SENT");
    return box.address;
  }
  throw lastError ?? new DeliveryFailedError();
}

/** Hourly (auth-housekeeping cron): deletes counts older than two days. */
export async function purgeOldMailboxSends(now: Date = new Date()): Promise<{ deleted: number }> {
  const deleted = await db
    .delete(emailMailboxSends)
    .where(lt(emailMailboxSends.createdAt, new Date(now.getTime() - SEND_LOG_RETAIN_MS)))
    .returning({ id: emailMailboxSends.id });
  return { deleted: deleted.length };
}
