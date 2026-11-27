/**
 * Who may call our Pico webhooks (docs/pico-xpress-2026-11): the secret we gave Pico (PICO_WEBHOOK_TOKEN), sent
 * as "Authorization: Bearer <token>", "X-GoKesari-Webhook-Token: <token>" or, because Pico's dashboard takes only a
 * URL (27-Nov-2026), as "?token=<token>" in the webhook URL. Compared in constant time. IP allowlist (rule
 * picoXpress.webhookIpAllowlist): Pico's dashboard lists 4.187.148.44 (sandbox) and 4.188.191.141 (production).
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Constant time, whatever the lengths (both sides hashed first). */
export function tokenMatches(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function presentedToken(headers: Headers, url?: string | null): string | null {
  const auth = headers.get("authorization")?.trim();
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    return (m ? m[1] : auth).trim() || null;
  }
  const header = headers.get("x-gokesari-webhook-token")?.trim();
  if (header) return header;
  if (!url) return null;
  try {
    return new URL(url, "https://invalid.local").searchParams.get("token")?.trim() || null;
  } catch {
    return null;
  }
}

/** The caller's address as the reverse proxy (Caddy) reports it. */
export function callerIp(headers: Headers): string | null {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim() || null;
  return headers.get("x-real-ip")?.trim() || null;
}

export function ipAllowed(ip: string | null, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!ip) return false;
  return allowlist.some((entry) => (entry.endsWith(".") || entry.endsWith(":") ? ip.startsWith(entry) : ip === entry));
}

export type WebhookAuthResult = { ok: true } | { ok: false; status: 401 | 403 | 503; reason: string };

export function checkWebhookAuth(headers: Headers, expectedToken: string | null, allowlist: readonly string[], url?: string | null): WebhookAuthResult {
  if (!expectedToken) return { ok: false, status: 503, reason: "Webhook not configured." };
  if (!ipAllowed(callerIp(headers), allowlist)) return { ok: false, status: 403, reason: "Address not allowed." };
  if (!tokenMatches(presentedToken(headers, url), expectedToken)) return { ok: false, status: 401, reason: "Unauthorized." };
  return { ok: true };
}
