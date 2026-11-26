/**
 * docs/onboarding-v2-2026-11 (Flow 2): `/shop/register?return=<path>` — after go-live (or once the registration
 * is with the team) the owner is sent back there; the franchise flow uses it ("live shop required, then back").
 * Only a same-site relative path is accepted: one leading "/", no "//" or "/\" (a protocol-relative URL), no
 * scheme, no control characters, at most 300 characters. Anything else is ignored (null).
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length < 1 || value.length > 300) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  if (/^\/+[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  try {
    // Resolved against a dummy origin it must stay on that origin.
    const url = new URL(value, "https://gokesari.invalid");
    if (url.origin !== "https://gokesari.invalid") return null;
    // Not back into the registration itself (a loop).
    if (url.pathname === "/shop/register") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
