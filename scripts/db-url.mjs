/**
 * Settings only libpq understands. postgres.js sends unknown URL settings to the
 * server as session settings, which Postgres refuses ("unrecognized configuration
 * parameter") — Neon's copy-paste URLs carry channel_binding=require.
 */
export const LIBPQ_ONLY_PARAMS = ["channel_binding", "gssencmode", "sslcert", "sslkey", "sslpassword", "sslcrl", "krbsrvname"];

/** A connection string postgres.js can open: trimmed, libpq-only settings removed. */
export function cleanDatabaseUrl(url) {
  const trimmed = String(url ?? "").trim();
  try {
    const u = new URL(trimmed);
    for (const key of LIBPQ_ONLY_PARAMS) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return trimmed;
  }
}
