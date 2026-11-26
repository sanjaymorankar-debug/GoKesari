/**
 * docs/onboarding-v2-2026-11: where the checkout login sheet comes back to after the e-mail step (Google, the
 * e-mailed link or code) — the page it was opened from, with ?sheet=resume so it continues by itself.
 */
import { safeReturnPath } from "@/lib/return-to";

export const SHEET_RESUME_PARAM = "sheet";
export const SHEET_RESUME_VALUE = "resume";

/** `/cart` → `/cart?sheet=resume`; an unsafe or missing path → `/cart?sheet=resume`. */
export function sheetResumePath(returnTo: string | null | undefined): string {
  const safe = safeReturnPath(returnTo) ?? "/cart";
  const url = new URL(safe, "https://resume.invalid");
  url.searchParams.set(SHEET_RESUME_PARAM, SHEET_RESUME_VALUE);
  return url.pathname + url.search;
}

/** True for a path the sheet resumes on (the /onboarding page sends such a sign-in straight back). */
export function isSheetResumePath(path: string | null | undefined): boolean {
  if (!path || !path.startsWith("/")) return false;
  try {
    return new URL(path, "https://resume.invalid").searchParams.get(SHEET_RESUME_PARAM) === SHEET_RESUME_VALUE;
  } catch {
    return false;
  }
}
