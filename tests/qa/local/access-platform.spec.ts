/**
 * Platform checks that need the local server's secrets, mail catcher or
 * database (QA package 2, local tier): an emailed sign-in code reaching a
 * mailbox and signing a seeded account in to its portal, the session
 * cookie's flags, the cron health probe and the dispatch counter, the
 * app's robots.txt, empty states of a brand-new account, and server-assigned
 * fields on a shop registration.
 */
import { randomInt } from "node:crypto";

import { as, me } from "../lib/actors";
import { db } from "../lib/db";
import { fulfil, placeOrder } from "../lib/flows";
import { anonymous, call, expectStatus, RUN, why } from "../lib/http";
import { messagesTo } from "../lib/mail";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";
import { apiFor, browserFor, freshCustomer, roleSwitcher, sessionOf, signInByEmail, worldUser } from "../lib/access-helpers";

const local = { tier: "local" as const, timeout: 300_000 };

qa("TC-PRE-005", "a sign-in code requested on /signin for a new email reaches its mailbox (SMTP works) and signs the new account in", async ({ browser }) => {
  const email = `qa-pre005-${RUN}@test.local`;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const since = Date.now() - 1000;
    const result = await signInByEmail(page, email);
    expect(result.signedIn, `new account signed in (${result.message})`).toBe(true);
    const mails = messagesTo(email, since);
    expect(mails.length, "the code email was received").toBeGreaterThan(0);
    const session = await sessionOf(page);
    expect(session?.role, "a new account starts as CUSTOMER").toBe("CUSTOMER");
    return `code mailed to ${email} (${mails.length} message), signed in as a new CUSTOMER, landed on ${new URL(result.url).pathname}`;
  } finally {
    await context.close();
  }
}, local);

qa("TC-PRE-007", "a seeded operator signs in with an emailed code and lands with the operator console reachable", async ({ browser }) => {
  const ops = need(worldUser("ops"), "the operator account");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const result = await signInByEmail(page, ops.email);
    expect(result.signedIn, `signed in (${result.message})`).toBe(true);
    const session = await sessionOf(page);
    expect(session?.role).toBe("OPERATOR");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(await roleSwitcher(page), "role switcher shows Operator").toHaveValue("OPERATOR");
    const res = await page.goto("/admin", { waitUntil: "domcontentloaded" });
    expect(res?.status(), "/admin").toBe(200);
    return `${ops.email} signed in by emailed code as OPERATOR; switcher 'Operator'; /admin 200`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "one seeded account signs in for real (each code request counts against the hourly limit); every account's session and portal is the signed-tier TC-PRE-007 check" });

qa("TC-SEC-006", "the session cookie of a real sign-in is HttpOnly and SameSite=Lax (Secure only on https)", async ({ browser }) => {
  const user = await freshCustomer("sec006");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const result = await signInByEmail(page, user.email);
    expect(result.signedIn, result.message).toBe(true);
    const cookie = (await context.cookies()).find((c) => /authjs\.session-token$/.test(c.name));
    const found = need(cookie, "the Auth.js session cookie after sign-in");
    expect(found.httpOnly, "HttpOnly").toBe(true);
    expect(found.sameSite, "SameSite").toBe("Lax");
    const https = page.url().startsWith("https:");
    expect(found.secure, "Secure follows the scheme").toBe(https);
    return `${found.name}: HttpOnly ${found.httpOnly}, SameSite ${found.sameSite}, Secure ${found.secure} (local http; Auth.js sets Secure and the __Secure- prefix on https)`;
  } finally {
    await context.close();
  }
}, { ...local, partial: "Secure needs https: checked on the sites by tests/qa/guest/signin-security.spec.ts (CSRF cookie, same options)" });

qa("TC-PRE-006", "cron: the health probe answers 200 with the cron secret and generates nothing; each dispatch run raises a READY order's rider-search attempt counter", async () => {
  const secret = process.env.CRON_SECRET ?? blocked("CRON_SECRET (the local server's) is not set");
  const guest = await anonymous();
  const out: string[] = [];
  const riders = await db()<{ user_id: string }[]>`select user_id from delivery_partners where is_online`;
  try {
    const [{ n: before }] = await db()<{ n: number }[]>`select count(*)::int as n from orders`;
    const probe = await call(guest, "GET", "/api/cron/daily-orders", undefined, { headers: { authorization: `Bearer ${secret}` } });
    expectStatus(probe, 200, "daily-orders health probe");
    expect(probe.body?.status).toBe("ready");
    const [{ n: after }] = await db()<{ n: number }[]>`select count(*)::int as n from orders`;
    expect(after, "the probe generated nothing").toBe(before);
    out.push(`GET /api/cron/daily-orders → 200 ${JSON.stringify(probe.body)}; no order generated`);
    // A READY order with no rider online.
    await db()`update delivery_partners set is_online = false where is_online`;
    const order = await placeOrder({ method: "WALLET" });
    for (const action of ["accept", "start", "ready"] as const) expectStatus(await fulfil(order.id, action), 200, action);
    const attempts = async () => (await db()<{ attempts: number }[]>`select attempts from rider_searches where order_id = ${order.id}`)[0]?.attempts ?? 0;
    const counts = [await attempts()];
    for (let i = 0; i < 2; i++) {
      // The next attempt is due (a minute has passed, as far as the search knows), and the scheduler calls the sweep.
      await db()`update rider_searches set next_attempt_at = now() - interval '1 second' where order_id = ${order.id}`;
      const run = await call(guest, "POST", "/api/cron/delivery-dispatch", {}, { headers: { authorization: `Bearer ${secret}` } });
      expectStatus(run, 200, "delivery-dispatch run");
      counts.push(await attempts());
    }
    expect(counts[1], "attempt counter after the first run").toBe(counts[0] + 1);
    expect(counts[2], "and after the second").toBe(counts[1] + 1);
    out.push(`rider search attempts ${counts.join(" → ")} over two dispatch runs`);
    const status = await call(await as("shop"), "GET", `/api/orders/${order.id}/assign`);
    if (status.status === 200) out.push(`shop sees: ${JSON.stringify(status.body).slice(0, 100)}`);
    await call(await as("shop"), "POST", `/api/orders/${order.id}/assign`, { stop: true, reason: "QA cron check done" });
  } finally {
    await guest.dispose();
    for (const r of riders) await db()`update delivery_partners set is_online = true where user_id = ${r.user_id}`;
  }
  return out.join("; ");
}, { ...local, partial: "the local server has no scheduler, so the test calls the dispatch cron as the host's scheduler would; whether the host schedules it every minute is checked on the test site (the exceptions page warns 'dispatch looks stalled')" });

qa("TC-SEC-008", "robots.txt of the app on a non-production host keeps search engines out", async () => {
  const guest = await anonymous();
  const res = await call(guest, "GET", "/robots.txt");
  await guest.dispose();
  expect(res.status, "D-05 (known): /robots.txt is missing").toBe(200);
  expect(res.text, "Disallow everything on a non-production host").toMatch(/Disallow:\s*\/\s*$/m);
  return `robots.txt: ${res.text.replace(/\s+/g, " ").slice(0, 120)}`;
}, { ...local, partial: "the agent allowed for testing is not named in a robots.txt that disallows all; production's robots.txt is the guest-tier check" });

qa("TC-UX-006", "a brand-new account sees helpful empty states on orders, subscriptions, returns, cart and notifications", async ({ browser }) => {
  const user = await freshCustomer("ux006", { withAddress: true });
  const { context, page } = await browserFor(browser, user);
  const out: string[] = [];
  const bad: string[] = [];
  try {
    for (const [path, expected] of [
      ["/orders", /no orders|haven.t (placed|ordered)|start shopping/i],
      ["/subscriptions", /no subscriptions|subscribe|nothing/i],
      ["/returns", /no returns|nothing to return|no return requests/i],
      ["/cart", /cart is empty|empty|start shopping/i],
      ["/notifications", /no notifications|all caught up|nothing/i],
    ] as [string, RegExp][]) {
      const res = await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      const text = await page.locator("main").innerText().catch(() => "");
      const status = res?.status() ?? 0;
      if (status >= 400) bad.push(`${path} → ${status}`);
      else if (/Something went wrong|Application error/i.test(text)) bad.push(`${path}: error page`);
      else if (!expected.test(text)) bad.push(`${path}: no empty-state message (${text.replace(/\s+/g, " ").slice(0, 80)})`);
      else out.push(`${path}: "${text.match(expected)?.[0]}"`);
    }
  } finally {
    await context.close();
  }
  expect(bad, bad.join("; ")).toEqual([]);
  return out.join("; ");
}, local);

qa("TC-SEC-004", "a self-service shop registration ignores status, classification, owner and fee sent in the request", async () => {
  const applicant = await freshCustomer("sec004", { withMobile: true });
  const admin = await me("admin");
  const ctx = await apiFor(applicant);
  const categories = (await call(ctx, "GET", "/api/shop-categories")).body?.categories as { id: string }[];
  const loc = need(world().location, "shop A's location");
  const body = (n: number) => ({
    name: `QA Sec004 Shop ${RUN} ${n}`,
    ownerName: "QA Sec Owner",
    phone: applicant.mobile ?? "9876509876",
    addressLine1: "1 QA Market Road",
    city: "Pune",
    pincode: loc.pincode,
    shopType: "GROCERY_KIRANA",
    categoryIds: [need(categories?.[0]?.id, "a shop category")],
    udyamNumber: `UDYAM-MH-26-${String(randomInt(1_000_000, 9_999_999))}`,
  });
  try {
    const plain = await call(ctx, "POST", "/api/shops", body(1));
    if (plain.status === 409 || plain.status === 422) blocked(`a plain self-registration is refused here: ${why(plain)}`);
    expectStatus(plain, 201, "plain registration");
    const injected = await call(ctx, "POST", "/api/shops", { ...body(2), status: "APPROVED", classification: "KESARI", ownerId: admin.id, registrationFeePaise: 0, lifecycleStatus: "LIVE", approvedAt: new Date().toISOString() });
    expectStatus(injected, [200, 201], "registration with server-assigned fields");
    const rows = await db()<{ id: string; status: string; classification: string | null; owner_id: string; registration_fee_paise: number | null; lifecycle_status: string }[]>`
      select id, status::text, classification::text, owner_id, registration_fee_paise, lifecycle_status::text from shops where id in (${plain.body.id}, ${injected.body.id})`;
    const p = rows.find((r) => r.id === plain.body.id)!;
    const i = rows.find((r) => r.id === injected.body.id)!;
    expect(i.status, "status stays server-assigned").toBe("PENDING_APPROVAL");
    expect(i.owner_id, "owner is the caller").toBe(applicant.id);
    expect(i.classification, "classification as for a plain registration").toBe(p.classification);
    expect(i.registration_fee_paise, "fee as for a plain registration").toBe(p.registration_fee_paise);
    expect(i.lifecycle_status).toBe(p.lifecycle_status);
    return `injected status/classification/owner/fee ignored: ${i.status}, classification ${i.classification}, owner = caller, fee ${i.registration_fee_paise} (same as a plain registration)`;
  } finally {
    await ctx.dispose();
  }
}, { ...local, partial: "the checkout total and profile role halves are the signed-tier TC-SEC-004 check" });
