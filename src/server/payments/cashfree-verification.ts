/**
 * Cashfree Verification Suite: the keys, the API host and the two-factor
 * signature, shared by every check that uses it — the bank account check
 * (services/bank-account-check.ts) and the FSSAI licence check
 * (kyc/adapters/cashfree.ts).
 *
 * Keys come from the environment only (CASHFREE_VERIFICATION_*). Cashfree
 * needs two-factor authentication even in its sandbox: either this server's IP
 * is whitelisted in the Cashfree dashboard, or CASHFREE_VERIFICATION_PUBLIC_KEY
 * holds the Secure ID public key and every call carries a signature.
 *
 * No database here, so the KYC adapters can use it without pulling in a service.
 */
import crypto from "node:crypto";

import { findCashfreeVerificationKeys, getEnv, type ServerEnv } from "@/lib/env";

export interface CashfreeVerificationConfig {
  clientId: string;
  clientSecret: string;
  publicKey: string | null;
  env: "sandbox" | "production";
  /** Which variable names held the id and secret (never their values). */
  foundAs: { clientId: string; clientSecret: string };
}

export const CASHFREE_VERIFICATION_KEY_NAMES = [
  ["CASHFREE_VERIFICATION_CLIENT_ID", "CASHFREE_VERIFICATION_CLIENT_SECRET"],
  ["CASHFREE_VERIFICATION_APP_ID", "CASHFREE_VERIFICATION_SECRET_KEY"],
] as const;

/** A PEM pasted into a host's settings often arrives with literal "\n"s. */
function normalizePem(raw: string | undefined): string | null {
  const value = raw?.replace(/\\n/g, "\n").trim();
  return value ? value : null;
}

/** The Verification Suite keys, or null when they are not set. */
export function cashfreeVerificationConfig(
  env: ServerEnv = getEnv(),
  other: ReturnType<typeof findCashfreeVerificationKeys> = findCashfreeVerificationKeys(),
): CashfreeVerificationConfig | null {
  for (const [idName, secretName] of CASHFREE_VERIFICATION_KEY_NAMES) {
    const clientId = env[idName];
    const clientSecret = env[secretName];
    if (clientId && clientSecret) {
      return {
        clientId,
        clientSecret,
        publicKey: normalizePem(env.CASHFREE_VERIFICATION_PUBLIC_KEY),
        env: env.CASHFREE_VERIFICATION_ENV ?? env.CASHFREE_ENV,
        foundAs: { clientId: idName, clientSecret: secretName },
      };
    }
  }
  // Keys saved on the host under another name (see findCashfreeVerificationKeys).
  if (other) {
    return {
      clientId: other.clientId,
      clientSecret: other.clientSecret,
      publicKey: normalizePem(env.CASHFREE_VERIFICATION_PUBLIC_KEY),
      env: env.CASHFREE_VERIFICATION_ENV ?? env.CASHFREE_ENV,
      foundAs: { clientId: other.idName, clientSecret: other.secretName },
    };
  }
  return null;
}

/**
 * Why the Verification Suite keys are not usable, naming only variables (never
 * values) — e.g. a secret saved without its client id. Null when they are set.
 */
export function cashfreeVerificationKeysProblem(env: ServerEnv = getEnv(), config = cashfreeVerificationConfig(env)): string | null {
  if (config) return null;
  for (const [idName, secretName] of CASHFREE_VERIFICATION_KEY_NAMES) {
    if (env[secretName] && !env[idName]) return `${secretName} is set but ${idName} is not.`;
    if (env[idName] && !env[secretName]) return `${idName} is set but ${secretName} is not.`;
  }
  return "CASHFREE_VERIFICATION_CLIENT_ID and CASHFREE_VERIFICATION_CLIENT_SECRET are not set.";
}

export function cashfreeVerificationApiBase(env: "sandbox" | "production"): string {
  return env === "production" ? "https://api.cashfree.com/verification" : "https://sandbox.cashfree.com/verification";
}

/** Cashfree's 2FA signature: "<client id>.<unix seconds>", RSA-OAEP (SHA-1) with the Secure ID public key, base64. */
export function cashfreeSignature(clientId: string, publicKeyPem: string, now: number = Date.now()): string {
  const data = Buffer.from(`${clientId}.${Math.floor(now / 1000)}`);
  return crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, data).toString("base64");
}
