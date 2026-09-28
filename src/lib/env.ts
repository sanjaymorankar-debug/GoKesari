/**
 * Environment configuration, validated once at process start.
 *
 * Secrets are read here and nowhere else. Nothing in this file may be imported
 * from a Client Component — the values are server-only.
 */
import { z } from "zod";

const serverEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  /**
   * Connection pool ceiling. Managed providers cap concurrent connections
   * (Neon's free tier notably so), and exceeding it produces confusing
   * intermittent failures rather than a clean error.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  // Auth.js
  AUTH_SECRET: z.string().min(1, "AUTH_SECRET is required"),
  AUTH_URL: z.string().url().optional(),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  /** Email magic-link sign-in (GS-001). Sender address, e.g. "Gokesari <no-reply@gokesari.com>". */
  AUTH_EMAIL_FROM: z.string().optional(),
  /** SMTP connection string, e.g. smtps://user:pass@smtp.host:465. Without it, links go to the console (non-production only). */
  AUTH_EMAIL_SERVER: z.string().optional(),

  // Cashfree. Absent in dev/test, in which case payments run in MOCK mode.
  CASHFREE_APP_ID: z.string().optional(),
  CASHFREE_SECRET_KEY: z.string().optional(),
  CASHFREE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),

  /**
   * Google Maps Platform — server-side Geocoding API key, used exactly once
   * per shop/address "Confirm location" action (see geocoding.ts). Deliberately
   * a SEPARATE key from NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (the browser-restricted
   * one the map picker loads client-side for Autocomplete/map display) — this
   * one should be IP-restricted, not domain-restricted, since it's never sent
   * to a browser. Absent in dev/test, in which case location capture falls
   * back to manual entry (no map, no verification) rather than failing.
   */
  GOOGLE_MAPS_SERVER_API_KEY: z.string().optional(),

  /**
   * GST/PAN verification providers (marketplace GST-readiness follow-up).
   * No provider is chosen yet — absent in every environment today, so
   * verification runs in self-declared mode (see gst-pan-verification.ts):
   * the shop owner's submission is stored as PENDING_VERIFICATION for an
   * admin to confirm by hand, never silently marked verified. Filling
   * these in later is a config change, not a code change.
   */
  GST_PROVIDER_API_KEY: z.string().optional(),
  PAN_PROVIDER_API_KEY: z.string().optional(),

  /**
   * Base64-encoded 32-byte AES-256-GCM key for encrypting PAN numbers at
   * rest. Required before any PAN can be submitted — there is deliberately
   * no fallback to plaintext storage.
   */
  PAN_ENCRYPTION_KEY: z.string().optional(),

  // Shared bearer token guarding the daily-order cron endpoint.
  CRON_SECRET: z.string().min(1, "CRON_SECRET is required"),

  // Comma-separated emails bootstrapped to ADMIN on first sign-in.
  BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),

  /**
   * Comma-separated emails re-promoted to ADMIN on every session refresh,
   * not just first sign-in (see permanentBootstrapAdminEmails() below) — for
   * the small number of accounts that must never be lockable-out even by an
   * accidental or malicious role change. SEC-03
   * (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): this used to be a
   * hard-coded list of personal emails baked into source, which meant
   * revoking one needed editing and redeploying code rather than an
   * operational change. Optional and empty by default — set it on a host to
   * get the stronger guarantee there.
   */
  PERMANENT_ADMIN_EMAILS: z.string().optional(),

  // Deliveries generated after this local time roll to the next day.
  SUBSCRIPTION_CUTOFF_HOUR: z.coerce.number().int().min(0).max(23).default(20),

  APP_TIMEZONE: z.string().default("Asia/Kolkata"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (cached) return cached;

  // Treat an empty variable (`FOO=` in a .env file) as unset. Otherwise an
  // optional secret becomes "" rather than undefined, and `??` fallbacks
  // silently fail to trigger.
  const raw: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    raw[key] = value === "" ? undefined : value;
  }

  const parsed = serverEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** True when real Cashfree credentials are configured. */
export function isPaymentGatewayLive(): boolean {
  const env = getEnv();
  return Boolean(env.CASHFREE_APP_ID && env.CASHFREE_SECRET_KEY);
}

/** Cashfree's API base URL for the configured environment. */
export function cashfreeApiBase(): string {
  return getEnv().CASHFREE_ENV === "production"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
}

/** True when the server-side Geocoding key is configured. */
export function isGeocodingConfigured(): boolean {
  return Boolean(getEnv().GOOGLE_MAPS_SERVER_API_KEY);
}

export function isGstProviderConfigured(): boolean {
  return Boolean(getEnv().GST_PROVIDER_API_KEY);
}

export function isPanProviderConfigured(): boolean {
  return Boolean(getEnv().PAN_PROVIDER_API_KEY);
}

export function isPanEncryptionConfigured(): boolean {
  return Boolean(getEnv().PAN_ENCRYPTION_KEY);
}

function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Emails re-promoted to ADMIN on every session refresh — see
 * PERMANENT_ADMIN_EMAILS above. Empty unless that variable is set; no
 * hard-coded fallback (SEC-03).
 */
export function permanentBootstrapAdminEmails(): readonly string[] {
  return parseEmailList(getEnv().PERMANENT_ADMIN_EMAILS);
}

/** Emails granted ADMIN on first sign-in — the union of both env-configured lists. */
export function bootstrapAdminEmails(): string[] {
  return Array.from(
    new Set([
      ...permanentBootstrapAdminEmails(),
      ...parseEmailList(getEnv().BOOTSTRAP_ADMIN_EMAILS),
    ]),
  );
}
