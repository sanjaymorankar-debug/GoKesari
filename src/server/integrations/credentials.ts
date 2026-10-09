/**
 * Encryption of integration secrets (API keys, OAuth tokens) — Module 2.
 *
 * AES-256-GCM with INTEGRATION_ENCRYPTION_KEY (base64, 32 bytes), a separate
 * key from PAN_ENCRYPTION_KEY so one leaking does not expose the other.
 * Stored as "v1:" + base64(iv[12] ‖ tag[16] ‖ ciphertext); the version prefix
 * lets the key be rotated later (re-encrypt with v2, accept both meanwhile).
 * Without the key, saving a secret is refused — never stored in plain text.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { validationFailed } from "@/lib/errors";

export const CREDENTIALS_KEY_VERSION = 1;

function key(): Buffer {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw validationFailed(
      "Accounting connections are not available yet: the server has no INTEGRATION_ENCRYPTION_KEY. Contact GoKesari support.",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("INTEGRATION_ENCRYPTION_KEY must be base64 of exactly 32 bytes.");
  return buf;
}

export function isCredentialEncryptionConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encryptCredentials(value: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v${CREDENTIALS_KEY_VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

export function decryptCredentials(stored: string | null | undefined): Record<string, unknown> {
  if (!stored) return {};
  const m = /^v(\d+):(.+)$/.exec(stored);
  if (!m || Number(m[1]) !== CREDENTIALS_KEY_VERSION) throw new Error("Unknown credentials format.");
  const raw = Buffer.from(m[2], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  return JSON.parse(text) as Record<string, unknown>;
}
