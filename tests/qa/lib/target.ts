/**
 * Which site the QA suite is pointed at, and what may run there.
 *
 *   local       a server on this machine with its own database (scripts/qa/local-up.sh):
 *               every tier runs, including cases that arrange data in the database
 *   staging     test.gokesari.com: guest and signed-in tiers, with the saved
 *               sessions of the staging test accounts (scripts/qa/signin-staging.ts)
 *   production  gokesari.com: the guest tier only — public pages and requests the
 *               server must refuse. Nothing that signs in, writes or pays.
 */
export type Target = "local" | "staging" | "production";

/**
 * guest   production-safe: GETs of public pages and requests that must be refused
 * signed  signs in a test account and may write test data (staging and local)
 * local   needs the server's database or secret (arranging data, minting sessions)
 */
export type Tier = "guest" | "signed" | "local";

export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
export const HOST = new URL(BASE_URL).host;
const HOSTNAME = new URL(BASE_URL).hostname;

export const TARGET: Target =
  HOSTNAME === "gokesari.com" || HOSTNAME === "www.gokesari.com"
    ? "production"
    : HOSTNAME === "test.gokesari.com" || HOSTNAME === "www.test.gokesari.com"
      ? "staging"
      : "local";

export const IS_PROD = TARGET === "production";
export const IS_LOCAL = TARGET === "local";
/** A deployed site (staging or production): keep request volume to what a person would cause. */
export const IS_REMOTE = !IS_LOCAL;

/** The reason a tier does not run on this target, or null when it does. */
export function tierRefusal(tier: Tier): string | null {
  if (tier === "guest") return null;
  if (IS_PROD) {
    return tier === "local"
      ? "not run on production: needs the server's database"
      : "not run on production: signs in and writes test data (production-safe tier only)";
  }
  if (tier === "local" && !IS_LOCAL) return `not run on ${TARGET}: needs the server's database (local run only)`;
  return null;
}

/** Throws unless the target may take writes — a second guard inside helpers that write. */
export function assertWritable(what: string) {
  if (IS_PROD) throw new Error(`Refusing to ${what} on ${HOST}: production is read-only for the QA suite.`);
}
