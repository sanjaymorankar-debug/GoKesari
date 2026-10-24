/**
 * The site's pages and API routes, read from the checkout (src/app) so a new
 * page or endpoint is covered by the access checks the day it is added. The
 * suite runs from the same commit that is deployed, so the list matches the
 * site under test.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const APP = join(process.cwd(), "src", "app");

function walk(dir: string, name: string, found: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, name, found);
    else if (entry === name) found.push(full);
  }
  return found;
}

/** "/shops/[slug]" style path of a page.tsx / route.ts (route groups dropped). */
function toPath(file: string) {
  const rel = relative(APP, file).split(sep).slice(0, -1).filter((s) => !/^\(.*\)$/.test(s));
  return "/" + rel.join("/");
}

/** Every page path, e.g. "/", "/admin/orders", "/shops/[slug]". */
export function pagePaths(): string[] {
  return walk(APP, "page.tsx").map(toPath).map((p) => (p === "/" ? "/" : p.replace(/\/$/, ""))).sort();
}

export const isDynamic = (path: string) => path.includes("[");

let pageList: string[] | undefined;

/**
 * The page a link opens ("/shops/anand-dairy?tab=x" → "/shops/[slug]"): a
 * static page first, else the dynamic page with the most fixed segments;
 * null when no page matches.
 */
export function pageRouteOf(link: string): string | null {
  pageList ??= pagePaths();
  const path = link.split(/[?#]/)[0].replace(/(.)\/$/, "$1") || "/";
  if (pageList.includes(path)) return path;
  const segs = path.split("/").filter(Boolean);
  const fixed = (p: string) => p.split("/").filter((s) => s && !s.startsWith("[")).length;
  for (const pattern of pageList.filter(isDynamic).sort((a, b) => fixed(b) - fixed(a))) {
    const parts = pattern.split("/").filter(Boolean);
    const rest = parts.findIndex((s) => s.startsWith("[..."));
    if (rest < 0 ? parts.length !== segs.length : segs.length <= rest) continue;
    if (parts.slice(0, rest < 0 ? parts.length : rest).every((s, i) => s.startsWith("[") || s === segs[i])) return pattern;
  }
  return null;
}

/** A syntactically valid id that exists nowhere, for dynamic segments. */
export const NO_SUCH_ID = "00000000-0000-4000-8000-000000000000";

export function fill(path: string, value = NO_SUCH_ID) {
  return path.replace(/\[\.\.\.[^\]]+\]/g, "x").replace(/\[[^\]]+\]/g, value);
}

/** Every audit action the app records (AUDIT_ACTIONS in src/server/services/audit.ts), read from the checkout. */
export function auditActions(): string[] {
  const src = readFileSync(join(process.cwd(), "src", "server", "services", "audit.ts"), "utf8");
  const block = src.slice(src.indexOf("export const AUDIT_ACTIONS"), src.indexOf("} as const", src.indexOf("export const AUDIT_ACTIONS")));
  return [...new Set([...block.matchAll(/:\s*"([a-z_]+(?:\.[a-z_]+)+)"/g)].map((m) => m[1]))];
}

export interface ApiRoute {
  path: string;
  methods: ("GET" | "POST" | "PUT" | "PATCH" | "DELETE")[];
  file: string;
}

/** Every API route with the HTTP methods its route.ts exports. */
export function apiRoutes(): ApiRoute[] {
  return walk(join(APP, "api"), "route.ts")
    .map((file) => {
      const src = readFileSync(file, "utf8");
      const methods = new Set<string>();
      for (const m of src.matchAll(/export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) methods.add(m[1]);
      for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(",")) {
          const name = part.trim().split(/\s+as\s+/).pop() ?? "";
          if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(name)) methods.add(name);
        }
      }
      return { path: toPath(file), methods: [...methods] as ApiRoute["methods"], file: relative(process.cwd(), file) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Pages anyone may open without signing in (the storefront, legal pages, the
 * forms that start a sign-up). Every other page must send a guest to /signin.
 */
export const PUBLIC_PAGES = new Set([
  "/",
  "/about",
  "/bakery", // redirects to /category/BAKERY
  "/dairy", // redirects to /category/DAIRY
  "/categories",
  "/category/[type]",
  "/contact",
  "/delivery-partner/apply", // the rider application starts here; submitting needs sign-in
  "/delivery/[token]", // a customer's delivery link, by unguessable token
  "/grievance",
  "/legal/cookie-policy",
  "/legal/grievance-redressal",
  "/legal/privacy-policy",
  "/legal/refund-policy",
  "/legal/seller-terms",
  "/legal/shipping-policy",
  "/legal/subscription-terms",
  "/legal/terms",
  "/legal/voucher-terms",
  "/legal/wallet-terms",
  "/mobile-auth/finish",
  "/operator", // redirects to /admin, which needs sign-in
  "/products/[id]",
  "/search",
  "/search/compare",
  "/sell",
  "/shop/join", // staff invitation landing; the invitation itself needs sign-in
  "/shop/join/[token]",
  "/shops",
  "/shops/[slug]",
  "/shops/[slug]/contact",
  "/shops/nearby",
  "/signin",
  "/orders/pay/sandbox/[ref]", // sandbox payment page (test site only; 404 on production)
]);

/**
 * Write endpoints that a signed-out caller may legitimately reach — each is
 * protected by something other than a session (a signature, a cron secret,
 * an API key, a one-time token) or is a public form. For these the access
 * check only asserts that the empty call is refused without a server error.
 */
export const PUBLIC_WRITES: Record<string, string> = {
  "/api/location": "the shopper's delivery location (a cookie), for guests too",
  "/api/otp/request": "asks for a sign-in code",
  "/api/grievances": "the public grievance form (Consumer Protection rules)",
  "/api/shop-registrations": "shop self-registration starts signed out, proven by a mobile code",
  "/api/shop-registrations/otp": "the code for shop self-registration",
  "/api/shop-registrations/referral-check": "checks a referral code on the registration form",
  "/api/shop-registrations/[token]": "a self-registration by its unguessable token",
  "/api/shop-registrations/[token]/pay": "pays a self-registration by its unguessable token",
  "/api/referral-requests": "the public 'refer a shop' form",
  "/api/delivery-link/[token]": "a delivery action by unguessable token",
  "/api/webhooks/cashfree": "payment gateway webhook: signature checked",
  "/api/webhooks/payments/[gateway]": "payment webhook: signature checked",
  "/api/webhooks/payouts/[provider]": "payout webhook: signature checked",
  "/api/dev/settle-registration": "development only: 404 in a production build",
  "/api/dev/settle-topup": "development only: 404 in a production build",
};

/** Route prefixes protected by a secret or key instead of a session. */
export const SECRET_PREFIXES: Record<string, string> = {
  "/api/cron/": "cron secret",
  "/api/v1/": "API key",
  "/api/connector/": "connector key",
  "/api/inbound/": "inbound mail secret",
  "/api/auth/": "Auth.js",
};
