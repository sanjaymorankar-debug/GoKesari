/**
 * Test bootstrap.
 *
 * Points the application's database singleton at the dedicated test database
 * BEFORE any application module is imported, so integration tests exercise real
 * SQL — constraints, locks and all — without touching development data.
 */
import "dotenv/config";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error(
    "TEST_DATABASE_URL must be set. Integration tests run against a real MySQL server.",
  );
}

// NODE_ENV is typed readonly by @types/node; assign through the record form.
const env = process.env as Record<string, string | undefined>;
env.DATABASE_URL = testUrl;
env.NODE_ENV = "test";
env.AUTH_SECRET ??= "test-secret";
env.CRON_SECRET ??= "test-cron-secret";
// Force-overridden, not `??=`: .env now carries real Cashfree sandbox
// credentials for manual testing, and dotenv/config above already loaded
// them into process.env. isPaymentGatewayLive() is `Boolean(APP_ID &&
// SECRET_KEY)`, so every test suite here assumes mock (non-live) mode —
// clearing APP_ID keeps that true regardless of what's in the developer's
// .env. SECRET_KEY stays a non-empty fake value: webhook HMAC tests sign
// against it directly, and that check doesn't depend on live/mock mode.
env.CASHFREE_APP_ID = "";
env.CASHFREE_SECRET_KEY = "test-webhook-secret";
// Fake key so isGeocodingConfigured() is true — tests that exercise the
// verify-location path stub global.fetch, so this never makes a real call.
env.GOOGLE_MAPS_SERVER_API_KEY ??= "test-google-maps-key";
// Force-cleared: no GST/PAN verification provider exists yet, and every test
// here assumes the self-declared/PENDING_VERIFICATION path (see
// gst-pan-verification.ts) — never the provider-lookup path.
env.GST_PROVIDER_API_KEY = "";
env.PAN_PROVIDER_API_KEY = "";
// Fixed test-only AES-256 key (32 bytes, base64) so PAN encryption tests
// don't depend on a real secret ever landing in .env.
env.PAN_ENCRYPTION_KEY ??= "VEqrHq1Y8qZmFzw8A9VFcDd+fsBqEXDUOA/9d0ieO+U=";
