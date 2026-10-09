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

  /**
   * Seconds an unused pooled connection stays open (0 = until the server
   * drops it). On a quiet site most visitors arrive after the pool has
   * emptied and pay for fresh TLS connections before the first query; on
   * test.gokesari.com that put the home page's origin time at 3-5 s cold
   * against ~0.5 s warm. Raising it keeps connections ready between visits,
   * at the cost of holding them open — check the provider's connection limit
   * and whether open connections stop the database scaling to zero.
   */
  DATABASE_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(3600).default(20),

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
   * Cashfree Verification Suite (Secure ID) — bank account check (docs/four-features-2026-10, O-7).
   * Its own client id / secret, not the payment keys. The *_APP_ID / *_SECRET_KEY spellings are
   * accepted too, matching the payment keys' names. Optional: without them the ₹1 check is used.
   */
  CASHFREE_VERIFICATION_CLIENT_ID: z.string().optional(),
  CASHFREE_VERIFICATION_CLIENT_SECRET: z.string().optional(),
  CASHFREE_VERIFICATION_APP_ID: z.string().optional(),
  CASHFREE_VERIFICATION_SECRET_KEY: z.string().optional(),
  /** Secure ID public key (PEM) for 2FA by signature; without it Cashfree must have this server's IP whitelisted. */
  CASHFREE_VERIFICATION_PUBLIC_KEY: z.string().optional(),
  /** Defaults to CASHFREE_ENV. */
  CASHFREE_VERIFICATION_ENV: z.enum(["sandbox", "production"]).optional(),

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
   * Seller document verification (PAN, GSTIN, Udyam, FSSAI, Shop Act) — see
   * src/server/kyc/. `mock` makes no network call and is the default for
   * local development and CI. test.gokesari.com runs the vendor's sandbox,
   * gokesari.com its live keys; kycConfigProblem() below refuses any other
   * pairing, so a live key on test or a sandbox key on production fails
   * loudly instead of quietly mis-verifying sellers.
   */
  KYC_PROVIDER: z.enum(["mock", "gridlines", "idfy"]).default("mock"),
  KYC_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  /** The one host allowed to use KYC_ENV=production (compared with AUTH_URL's host). */
  KYC_PRODUCTION_HOST: z.string().default("gokesari.com"),
  KYC_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(8000),
  GRIDLINES_API_KEY: z.string().optional(),
  /** Only to point at a sandbox host if Gridlines gives one; defaults to the live API host. */
  GRIDLINES_BASE_URL: z.string().url().optional(),
  /** IDfy, the backup vendor. Its adapter is added if Gridlines is replaced or needs a fallback. */
  IDFY_ACCOUNT_ID: z.string().optional(),
  IDFY_API_KEY: z.string().optional(),

  /**
   * Base64-encoded 32-byte AES-256-GCM key for encrypting PAN numbers at
   * rest. Required before any PAN can be submitted — there is deliberately
   * no fallback to plaintext storage.
   */
  PAN_ENCRYPTION_KEY: z.string().optional(),

  /**
   * Module 1: absolute path of a folder OUTSIDE the web root where product
   * photos are written (random file names, served only through
   * /api/images/{id}). Unset: photos are kept in the database, as before.
   * On Hostinger use a folder in the account's home that a redeploy does not
   * replace, and back it up with the database.
   */
  MEDIA_DIR: z.string().optional(),

  /**
   * Module 2: base64 of a 32-byte AES-256-GCM key for shops' accounting
   * software secrets (Odoo API keys, Zoho refresh tokens). Without it no
   * secret can be saved (never stored in plain text). Separate from
   * PAN_ENCRYPTION_KEY. Back it up: losing it means every shop reconnects.
   */
  INTEGRATION_ENCRYPTION_KEY: z.string().optional(),
  /** "off" stops running sync jobs straight after commit (tests run the dispatcher themselves). */
  INTEGRATION_AUTODISPATCH: z.enum(["on", "off"]).default("on"),
  /** Module 2: GoKesari's Zoho API client (api-console.zoho.in, server-based), redirect URI <AUTH_URL>/api/integrations/zoho/callback. */
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),
  /**
   * Module 2: the GST Suvidha Provider for GSTIN look-up, e-invoice (IRN)
   * and e-way bills. `mock` (sandbox-shaped, no network) until a licensed GSP
   * is chosen; gspConfigProblem() applies the same production/sandbox pairing
   * as KYC.
   */
  GSP_PROVIDER: z.enum(["mock"]).default("mock"),
  /**
   * Module 3: SMS and WhatsApp. `none` (default) = not sent. `mock` = written
   * to outbound_test_messages for testers to read at /admin/test-messages
   * (test site only; refused on the production site). Real providers (MSG91
   * DLT for SMS, Meta Cloud API for WhatsApp) are added when chosen.
   */
  SMS_PROVIDER: z.enum(["none", "mock"]).default("none"),
  WHATSAPP_PROVIDER: z.enum(["none", "mock"]).default("none"),
  GSP_ENV: z.enum(["sandbox", "production"]).default("sandbox"),

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

  /**
   * Links to this site opening in the installed Android/iOS app (mobile/
   * README.md, "Deep links"). Unset, /.well-known/assetlinks.json and
   * /.well-known/apple-app-site-association answer 404 and links simply open
   * in the browser — nothing else depends on them. test.gokesari.com lists
   * the preview build (com.gokesari.app.preview), gokesari.com the store one.
   */
  MOBILE_ANDROID_PACKAGE: z.string().default("com.gokesari.app"),
  /** Comma-separated SHA-256 signing-certificate fingerprints (Play Console → Test and release → App integrity). */
  MOBILE_ANDROID_CERT_SHA256: z.string().optional(),
  /** Comma-separated `<Apple Team ID>.<bundle id>`, e.g. `ABCDE12345.com.gokesari.app`. */
  MOBILE_IOS_APP_IDS: z.string().optional(),
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

/**
 * Why seller-document verification must not run with the current settings,
 * or null when it may. Checked on every verification call rather than at
 * boot, so a KYC misconfiguration stops verification (documents wait in
 * PENDING) without taking the whole site down.
 */
export function kycConfigProblem(env: ServerEnv = getEnv()): string | null {
  let host = "";
  try {
    host = env.AUTH_URL ? new URL(env.AUTH_URL).hostname.toLowerCase() : "";
  } catch {
    host = "";
  }
  const prodHost = env.KYC_PRODUCTION_HOST.toLowerCase();
  const isProductionHost = host === prodHost || host === `www.${prodHost}`;

  if (isProductionHost && env.KYC_PROVIDER === "mock") {
    return "KYC_PROVIDER=mock is not allowed on the production site.";
  }
  if (isProductionHost && env.KYC_ENV !== "production") {
    return "The production site must use KYC_ENV=production (live vendor keys).";
  }
  if (!isProductionHost && env.KYC_ENV === "production") {
    return `KYC_ENV=production is only allowed on ${prodHost}; this host (${host || "no AUTH_URL"}) must use sandbox keys.`;
  }
  if (env.KYC_PROVIDER === "gridlines" && !env.GRIDLINES_API_KEY) {
    return "KYC_PROVIDER=gridlines needs GRIDLINES_API_KEY.";
  }
  if (env.KYC_PROVIDER === "idfy" && !(env.IDFY_ACCOUNT_ID && env.IDFY_API_KEY)) {
    return "KYC_PROVIDER=idfy needs IDFY_ACCOUNT_ID and IDFY_API_KEY.";
  }
  return null;
}

/** Why GST calls through the GSP must not run with these settings, or null. Same host pairing as KYC. */
export function gspConfigProblem(env: ServerEnv = getEnv()): string | null {
  let host = "";
  try {
    host = env.AUTH_URL ? new URL(env.AUTH_URL).hostname.toLowerCase() : "";
  } catch {
    host = "";
  }
  const prodHost = env.KYC_PRODUCTION_HOST.toLowerCase();
  const isProductionHost = host === prodHost || host === `www.${prodHost}`;
  if (isProductionHost && env.GSP_PROVIDER === "mock") return "GSP_PROVIDER=mock is not allowed on the production site.";
  if (isProductionHost && env.GSP_ENV !== "production") return "The production site must use GSP_ENV=production.";
  if (!isProductionHost && env.GSP_ENV === "production") {
    return `GSP_ENV=production is only allowed on ${prodHost}; this host (${host || "no AUTH_URL"}) must use the GSP sandbox.`;
  }
  return null;
}

/** Why SMS / WhatsApp must not send with these settings, or null. The mock never runs on the production site. */
export function messagingConfigProblem(env: ServerEnv = getEnv()): string | null {
  let host = "";
  try {
    host = env.AUTH_URL ? new URL(env.AUTH_URL).hostname.toLowerCase() : "";
  } catch {
    host = "";
  }
  const prodHost = env.KYC_PRODUCTION_HOST.toLowerCase();
  const isProductionHost = host === prodHost || host === `www.${prodHost}`;
  if (isProductionHost && (env.SMS_PROVIDER === "mock" || env.WHATSAPP_PROVIDER === "mock")) {
    return "SMS_PROVIDER / WHATSAPP_PROVIDER=mock is not allowed on the production site.";
  }
  return null;
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

function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** The installed apps allowed to open this site's links (see MOBILE_* above). */
export function mobileAppLinkConfig(): {
  androidPackage: string;
  androidCertFingerprints: string[];
  iosAppIds: string[];
} {
  const env = getEnv();
  return {
    androidPackage: env.MOBILE_ANDROID_PACKAGE,
    androidCertFingerprints: parseList(env.MOBILE_ANDROID_CERT_SHA256).map((f) => f.toUpperCase()),
    iosAppIds: parseList(env.MOBILE_IOS_APP_IDS),
  };
}
