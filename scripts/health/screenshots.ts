/**
 * GoKesari Health — screenshots of the key screens for the testing report (docs/health/screenshots/).
 * Local / test only: signs the demo accounts in with session cookies minted with the server's AUTH_SECRET.
 *
 *   BASE_URL=http://localhost:3880 AUTH_SECRET=… DATABASE_URL=… npx tsx scripts/health/screenshots.ts
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { encode } from "next-auth/jwt";
import { chromium, type BrowserContext } from "@playwright/test";
import postgres from "postgres";

const BASE = process.env.BASE_URL ?? "http://localhost:3880";
const OUT = process.env.OUT_DIR ?? "docs/health/screenshots";
const COOKIE = BASE.startsWith("https") ? "__Secure-authjs.session-token" : "authjs.session-token";

async function cookieFor(sql: postgres.Sql, email: string): Promise<string> {
  const [u] = await sql`select id, email, name from users where email = ${email}`;
  if (!u) throw new Error(`no user ${email}`);
  return encode({ token: { sub: u.id, sid: randomUUID(), email: u.email, name: u.name }, secret: process.env.AUTH_SECRET!, salt: COOKIE, maxAge: 3600 });
}

async function main() {
  if (BASE.includes("gokesari.com") && !BASE.includes("test.")) throw new Error("Screenshots run on local or test sites only.");
  mkdirSync(OUT, { recursive: true });
  const sql = postgres(process.env.DATABASE_URL!);
  const [rx] = await sql`select id from health.prescriptions where status = 'ISSUED' order by issued_at desc limit 1`;
  const [cons] = await sql`select id from health.consultations order by started_at desc limit 1`;
  const [self] = await sql`select p.id from health.patients p join users u on u.id = p.account_user_id where u.email = 'customer@example.com' and p.relation = 'SELF'`;
  const browser = await chromium.launch();
  const url = new URL(BASE);
  const shots: { who: string; name: string; path: string; mobile?: boolean; wait?: string }[] = [
    { who: "customer@example.com", name: "01-my-health-hub", path: "/health", mobile: true },
    { who: "customer@example.com", name: "02-records-timeline", path: `/health/records?patient=${self?.id ?? ""}`, mobile: true },
    { who: "customer@example.com", name: "03-records-medicines", path: `/health/records?patient=${self?.id ?? ""}&view=medicines`, mobile: true },
    { who: "customer@example.com", name: "04-prescription", path: `/health/prescriptions/${rx?.id}`, mobile: true },
    { who: "customer@example.com", name: "05-prescription-print", path: `/health/prescriptions/${rx?.id}/print?auto=0` },
    { who: "customer@example.com", name: "06-privacy-access-log", path: `/health/privacy?patient=${self?.id ?? ""}`, mobile: true },
    { who: "customer@example.com", name: "07-family", path: "/health/family", mobile: true },
    { who: "customer@example.com", name: "08-find-doctor", path: "/health/doctors", mobile: true },
    { who: "customer@example.com", name: "09-appointments", path: "/health/appointments", mobile: true },
    { who: "customer@example.com", name: "10-medicine-orders", path: "/health/medicines", mobile: true },
    { who: "customer@example.com", name: "11-home-care", path: "/health/care", mobile: true },
    { who: "customer@example.com", name: "12-equipment", path: "/health/equipment", mobile: true },
    { who: "clinic@example.com", name: "20-clinic-today", path: "/shop/health" },
    { who: "clinic@example.com", name: "21-consultation-pad", path: `/shop/health/consult/${cons?.id}` },
    { who: "clinic@example.com", name: "22-doctor-print-settings", path: "/shop/health/settings" },
    { who: "clinic@example.com", name: "23-shop-health-hub", path: "/shop/health/hub", mobile: true },
    { who: "clinic@example.com", name: "24-prime", path: "/shop/health/prime" },
    { who: "admin@example.com", name: "30-admin-health", path: "/admin/health" },
    { who: "customer@example.com", name: "40-rx-verify", path: `/rx/verify/none-such-token-0000000`, mobile: true },
  ];
  const contexts = new Map<string, BrowserContext>();
  for (const s of shots) {
    const key = `${s.who}:${s.mobile ? "m" : "d"}`;
    let ctx = contexts.get(key);
    if (!ctx) {
      ctx = await browser.newContext(s.mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
      await ctx.addCookies([{ name: COOKIE, value: await cookieFor(sql, s.who), domain: url.hostname, path: "/", httpOnly: true, secure: BASE.startsWith("https"), sameSite: "Lax" }]);
      contexts.set(key, ctx);
    }
    const page = await ctx.newPage();
    try {
      const res = await page.goto(`${BASE}${s.path}`, { waitUntil: "networkidle", timeout: 120_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/${s.name}.png`, fullPage: true });
      console.log(`${s.name}: ${res?.status()} ${page.url().replace(BASE, "")}`);
    } catch (e) {
      console.log(`${s.name}: FAILED ${(e as Error).message.split("\n")[0]}`);
    } finally {
      await page.close();
    }
  }
  await browser.close();
  await sql.end();
}

void main();
