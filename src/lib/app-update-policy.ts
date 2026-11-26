/**
 * docs/silent-update-2026-11: the rules behind silent updates (plain
 * TypeScript, unit-tested in tests/unit/app-update-policy.test.ts).
 *
 * A new website version installs in the background and is switched to only
 * at a safe moment — never during checkout, payment, an unsaved form or an
 * upload. Nobody is ever asked to "Reload".
 */

/** Pages where the switch never happens on its own (payment, checkout, registration, billing). */
const SENSITIVE_PATHS: RegExp[] = [
  /^\/cart(\/|$)/,
  /^\/checkout(\/|$)/,
  /^\/orders\/pay(\/|$)/,
  /^\/orders\/payment-return(\/|$)/,
  /^\/wallet(\/|$)/,
  /^\/onboarding(\/|$)/,
  /^\/sell(\/|$)/,
  /^\/subscribe(\/|$)/,
  /^\/franchise(\/|$)/,
  /^\/shop\/billing(\/|$)/,
  /^\/signin(\/|$)/,
  /^\/mobile-auth(\/|$)/,
];

export function isSensitivePath(pathname: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(pathname));
}

export interface PageState {
  pathname: string;
  /** The person typed, picked a file or changed a field on this page. */
  dirty: boolean;
  /** A payment window (Cashfree) is open on the page. */
  paymentOpen: boolean;
}

/** True when switching to the new version now cannot lose anything. */
export function canApplyUpdate(state: PageState): boolean {
  return !state.dirty && !state.paymentOpen && !isSensitivePath(state.pathname);
}

/** No interaction for this long counts as idle: the switch may happen then. */
export const IDLE_APPLY_MS = 5 * 60_000;
/** An open tab asks for a new version at most this often (plus on start and when it comes back to view). */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;
/** Coming back to the tab checks again, but not more often than this. */
export const FOCUS_CHECK_MIN_MS = 60_000;

/** A lazy-loaded piece of an older version was removed by a deploy. */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  const message =
    typeof error === "string" ? error : typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : "";
  return (
    name === "ChunkLoadError" ||
    /Loading (CSS )?chunk [\w-]+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message)
  );
}

export const CHUNK_RELOAD_KEY = "gk_chunk_reload_at";
/** One silent recovery reload per tab within this window; a second failure shows the normal error page (no loop). */
export const CHUNK_RELOAD_WINDOW_MS = 5 * 60_000;

export function mayRecoverFromChunkError(lastReloadAt: string | null, now: number): boolean {
  const last = Number(lastReloadAt);
  return !Number.isFinite(last) || last <= 0 || now - last > CHUNK_RELOAD_WINDOW_MS;
}

/**
 * Reloads once, silently, after a stale-chunk error. Returns false when a
 * recovery reload already happened in this tab recently (the error page then
 * shows as usual instead of reloading in a loop).
 */
export function recoverFromChunkError(error: unknown): boolean {
  if (typeof window === "undefined" || !isChunkLoadError(error)) return false;
  let last: string | null = null;
  try {
    last = window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
  } catch {
    return false; // No session storage: no way to guard against a loop, so no reload.
  }
  if (!mayRecoverFromChunkError(last, Date.now())) return false;
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  console.warn("[gk-update] stale chunk after a deploy; reloading once", error);
  window.location.reload();
  return true;
}

/** Browser-kept data that belongs to whoever was signed in; cleared when that person signs out or another signs in. */
export const USER_SCOPED_STORAGE_KEYS = ["gk_recent_searches", "gk_favourites"] as const;
/** Remembers which account this browser last showed (an opaque id, or "guest"). */
export const LAST_USER_KEY = "gk_last_user";

/**
 * True when the previous account's browser-kept data must go: a signed-in
 * person signed out, or a different person signed in. A guest signing in
 * keeps theirs (the guest cart and favourites move into the account).
 */
export function mustClearUserData(previous: string | null, current: string): boolean {
  return previous !== null && previous !== "guest" && previous !== current;
}
