/**
 * Sandbox.co.in webhooks (developer.sandbox.co.in/guides/developer-resources/webhooks):
 * `x-sandbox-signature` is the base64 HMAC-SHA256 of the payload, keyed with
 * the secret set in the Sandbox Console. Sandbox's own example signs
 * `JSON.stringify(payload)` of the parsed body; the raw bytes are accepted too,
 * in case the two ever differ. Compared in constant time.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function sign(secret: string, text: string): Buffer {
  return createHmac("sha256", secret).update(text, "utf8").digest();
}

function matches(expected: Buffer, given: Buffer): boolean {
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function verifySandboxSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const given = Buffer.from(signature.trim(), "base64");
  if (given.length === 0) return false;
  if (matches(sign(secret, rawBody), given)) return true;
  try {
    return matches(sign(secret, JSON.stringify(JSON.parse(rawBody))), given);
  } catch {
    return false;
  }
}

/** The session id in a DigiLocker session webhook (`data.id`), or null when the payload is not one. */
export function digilockerWebhookSessionId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && /^[A-Za-z0-9-]{8,80}$/.test(id) ? id : null;
}
