/**
 * AES-256-GCM encryption for PAN numbers at rest (marketplace GST-readiness
 * follow-up). PAN is a government identity credential, not a free-text
 * field — schema.ts stores only ciphertext (`panNumberEncrypted`) plus the
 * last 4 characters in plaintext for masked display, never the full number.
 *
 * The same key and format also protect delivery-partner KYC and bank details
 * (SEC-02) through encryptSecret/decryptSecret; encryptPan/decryptPan are the
 * same functions under the name the shop flow already uses.
 *
 * Deliberately throws rather than falling back to plaintext when
 * PAN_ENCRYPTION_KEY is unset — see isPanEncryptionConfigured() in env.ts.
 * Losing or changing that key makes every value encrypted with it
 * unrecoverable, and there is no key id in the ciphertext, so rotating it
 * means re-encrypting everything — see DEPLOYMENT.md.
 */
import crypto from "node:crypto";

import { getEnv, isPanEncryptionConfigured } from "@/lib/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey(): Buffer {
  if (!isPanEncryptionConfigured()) {
    throw new Error("PAN_ENCRYPTION_KEY is not configured — cannot store sensitive identity data.");
  }
  const key = Buffer.from(getEnv().PAN_ENCRYPTION_KEY!, "base64");
  if (key.length !== 32) {
    throw new Error("PAN_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).");
  }
  return key;
}

/** Returns base64(iv || authTag || ciphertext). */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export const encryptPan = encryptSecret;

export function decryptSecret(encoded: string): string {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export const decryptPan = decryptSecret;

/** "XXXXXX1234F"-style masked display — never the full number. */
export function maskPan(last4: string): string {
  return `XXXXXX${last4}`;
}
