/**
 * Consultant appointments (docs/consult-booking-2026-11), signed in, through the
 * real APIs and pages: shop owner B sets up a test practice ("QA Test Clinic",
 * kept live on the test site as the demo consultant), customers book, move,
 * cancel, pay at the visit or online (sandbox), the consultant records payment
 * and completes with the customer's code, admin reads everything, and nobody
 * else sees anything.
 *
 * Signed-in tier (test.gokesari.com and the local server). Writes: the test
 * practice on shop B (idempotent), bookings whose visitor is "QA CON <run>",
 * one help-desk ticket per run (dispute check). Never on production
 * (assertWritable). Each check stands alone: it books its own times.
 */
import { as, pageAs } from "../lib/actors";
import { shopOf } from "../lib/flows";
import { call, expectStatus, pace, RUN, why, type Answer } from "../lib/http";
import { blocked, expect, manual, need, qa } from "../lib/record";
import { NO_SUCH_ID } from "../lib/routes";
import { assertWritable } from "../lib/target";
import { world, type Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 300_000 };
const OWNER: Role = "shopB";
const VISITOR = `QA CON ${RUN}`;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:00", end: "24:00" }));

interface Practice {
  shopId: string;
  slug: string;
  ownerMemberId: string;
  assistantId: string;
  services: Record<"free" | "quick" | "visit" | "online" | "group" | "team", string>;
}

const SERVICES: { key: keyof Practice["services"]; body: Record<string, unknown> }[] = [
  { key: "free", body: { name: "QA Free consultation", durationMinutes: 15, feeType: "FREE", modes: ["IN_PERSON", "VIDEO"] } },
  { key: "quick", body: { name: "QA Quick check", durationMinutes: 5, feeType: "FREE", modes: ["IN_PERSON"] } },
  { key: "visit", body: { name: "QA Pay at visit", durationMinutes: 15, feeType: "FIXED", feeRupees: 1, payOnline: false, payAtVisit: true, modes: ["IN_PERSON"] } },
  { key: "online", body: { name: "QA Online consultation", durationMinutes: 15, feeType: "FIXED", feeRupees: 1, payOnline: true, payAtVisit: false, modes: ["IN_PERSON", "VIDEO"] } },
  { key: "group", body: { name: "QA Group workshop", durationMinutes: 30, feeType: "FREE", bookingKind: "GROUP", capacity: 3, modes: ["IN_PERSON"] } },
  { key: "team", body: { name: "QA Team review", durationMinutes: 15, feeType: "FREE", bookingKind: "TEAM", requiredMembers: 2, modes: ["IN_PERSON"] } },
];

async function firm(role: Role, shopId: string, method: "GET" | "POST", body?: Record<string, unknown>, query = "") {
  return call(await as(role), method, `/api/consult/firm/${shopId}${query}`, body);
}

/** The test practice on shop B: made once, kept live (idempotent, so every check can call it). */
async function practice(): Promise<Practice> {
  assertWritable("set up a test consultant");
  need(world().users[OWNER], "shop owner B (the test consultant's account)");
  const shop = await shopOf("B");
  const search = await call(await as("customer"), "GET", "/api/consult/search?q=x");
  if (search.status === 404) blocked("rule consultBooking is off on this site (Admin → Settings)");
  let setup = await firm(OWNER, shop.id, "GET", undefined, "?view=setup");
  expectStatus(setup, 200, "setup view");
  if (setup.body.profile.displayName !== "QA Test Clinic") {
    expectStatus(await firm(OWNER, shop.id, "POST", { action: "profile", profile: { displayName: "QA Test Clinic", headline: "Test consultant for the QA suite — not a real practice", minNoticeMinutes: 0, latitude: 18.5308, longitude: 73.8475, bookingWindowDays: 30, completionOtp: true } }), 200, "profile");
  }
  setup = await firm(OWNER, shop.id, "GET", undefined, "?view=setup");
  const members = setup.body.members as { id: string; name: string; isOwner: boolean; hours: unknown[]; slotMinutes: number }[];
  const ownerMember = need(members.find((m) => m.isOwner), "the owner's consultant row");
  if (ownerMember.slotMinutes !== 5) expectStatus(await firm(OWNER, shop.id, "POST", { action: "member", member: { id: ownerMember.id, name: "QA Doctor", languages: ["English", "Marathi"], slotMinutes: 5 } }), 200, "owner member");
  let assistant = members.find((m) => m.name === "QA Assistant");
  if (!assistant) {
    const made = await firm(OWNER, shop.id, "POST", { action: "member", member: { name: "QA Assistant", languages: ["English", "Hindi"], slotMinutes: 5 } });
    expectStatus(made, 200, "assistant member");
    assistant = made.body.member;
  }
  for (const m of [ownerMember, assistant!]) {
    if ((members.find((x) => x.id === m.id)?.hours.length ?? 0) < 7) expectStatus(await firm(OWNER, shop.id, "POST", { action: "hours", memberId: m.id, rows: EVERY_DAY }), 200, "hours");
  }
  const existing = setup.body.services as { id: string; name: string }[];
  const services = {} as Practice["services"];
  for (const s of SERVICES) {
    const found = existing.find((x) => x.name === s.body.name);
    if (found) services[s.key] = found.id;
    else {
      const made = await firm(OWNER, shop.id, "POST", { action: "service", service: s.body });
      expectStatus(made, 200, `service ${s.body.name}`);
      services[s.key] = made.body.service.id;
    }
  }
  setup = await firm(OWNER, shop.id, "GET", undefined, "?view=setup");
  if (setup.body.profile.status !== "LIVE") {
    const pub = await firm(OWNER, shop.id, "POST", { action: "publish" });
    expect(pub.status, `publish — ${why(pub)}`).toBe(200);
  }
  let slug = shop.slug;
  if (!slug) {
    const found = await call(await as("customer"), "GET", `/api/consult/search?q=${encodeURIComponent("QA Test Clinic")}`);
    slug = need((found.body?.results as { shopId: string; slug: string }[] | undefined)?.find((r) => r.shopId === shop.id)?.slug, "the test practice's page address");
  }
  return { shopId: shop.id, slug, ownerMemberId: ownerMember.id, assistantId: assistant!.id, services };
}

interface Slot {
  start: string;
  memberIds: string[];
  places: number;
}

/** Free starts of a service (today and the next days), optionally for one member. */
async function freeStarts(serviceId: string, options: { memberId?: string; from?: string; days?: number; attendees?: number } = {}): Promise<Slot[]> {
  const q = new URLSearchParams({ serviceId, days: String(options.days ?? 2), attendees: String(options.attendees ?? 1) });
  if (options.memberId) q.set("memberId", options.memberId);
  if (options.from) q.set("from", options.from);
  const res = await call(await as("customer"), "GET", `/api/consult/availability?${q.toString()}`);
  expectStatus(res, 200, "availability");
  return Object.keys(res.body.days)
    .sort()
    .flatMap((d) => res.body.days[d] as Slot[]);
}

/** A free start at least `hoursAhead` from now (spreads checks apart). */
async function startAhead(serviceId: string, hoursAhead: number, memberId?: string): Promise<string> {
  const slots = await freeStarts(serviceId, { memberId, days: 3 });
  const after = Date.now() + hoursAhead * 3_600_000;
  return need(slots.find((s) => new Date(s.start).getTime() >= after)?.start, `a free time ${hoursAhead} h ahead`);
}

async function book(role: Role, body: Record<string, unknown>): Promise<Answer> {
  return call(await as(role), "POST", "/api/consult/bookings", { mode: "IN_PERSON", visitorName: VISITOR, consent: true, ...body });
}

async function bookingOf(role: Role, id: string): Promise<Answer> {
  return call(await as(role), "GET", `/api/consult/bookings/${id}`);
}

async function act(role: Role, id: string, action: string, extra: Record<string, unknown> = {}): Promise<Answer> {
  return call(await as(role), "POST", `/api/consult/bookings/${id}`, { action, ...extra });
}

/* ================================================================ setup */

qa(["TC-CON-005"], "a consultant sets up a profile, team, hours and services and publishes; customers find it by name", async () => {
  const p = await practice();
  const setup = await firm(OWNER, p.shopId, "GET", undefined, "?view=setup");
  expect(setup.body.profile.status).toBe("LIVE");
  expect(setup.body.problems).toEqual([]);
  const found = await call(await as("customer"), "GET", `/api/consult/search?q=${encodeURIComponent("QA Test Clinic")}`);
  expectStatus(found, 200, "search");
  const card = need((found.body.results as { slug: string; nextSlot: string | null; modes: string[] }[]).find((r) => r.slug === p.slug), "the test practice in search");
  expect(card.nextSlot, "next free time").toBeTruthy();
  expect(card.modes).toEqual(expect.arrayContaining(["IN_PERSON", "VIDEO"]));
  return `LIVE with ${Object.keys(p.services).length} services and 2 consultants; next free ${card.nextSlot}`;
}, signed);

qa(["TC-CON-021"], "near me: the search orders by distance with a directions link; far away finds nothing", async () => {
  const p = await practice();
  const near = await call(await as("customer"), "GET", "/api/consult/search?lat=18.5310&lng=73.8470&radiusKm=10");
  expectStatus(near, 200, "near search");
  const results = near.body.results as { slug: string; distanceKm: number | null; directionsUrl: string | null; distanceText: string | null }[];
  const mine = need(results.find((r) => r.slug === p.slug), "the test practice near its own pin");
  expect(mine.distanceKm!, "distance km").toBeLessThan(1);
  expect(mine.directionsUrl ?? "").toContain("google.com/maps/dir");
  const distances = results.map((r) => r.distanceKm ?? 0);
  expect([...distances].sort((a, b) => a - b), "nearest first").toEqual(distances);
  const far = await call(await as("customer"), "GET", "/api/consult/search?lat=28.6139&lng=77.2090&radiusKm=25");
  expect((far.body.results as { slug: string }[]).some((r) => r.slug === p.slug), "not found from Delhi").toBe(false);
  return `${results.length} near (test practice ${mine.distanceText}); none of ours from Delhi`;
}, signed);

/* ============================================================== booking */

qa(["TC-CON-007", "TC-CON-024"], "a free booking is confirmed at once, its time leaves availability, and both sides are notified", async () => {
  const p = await practice();
  const start = await startAhead(p.services.free, 6, p.ownerMemberId);
  const res = await book("customer", { serviceId: p.services.free, memberId: p.ownerMemberId, start });
  expectStatus(res, 201, "book");
  expect(res.body.booking.status).toBe("CONFIRMED");
  expect(res.body.booking.bookingNumber).toMatch(/^CB\d{4}-\d{6}$/);
  const after = await freeStarts(p.services.free, { memberId: p.ownerMemberId, days: 3 });
  expect(after.some((s) => s.start === start), "the booked time is no longer offered").toBe(false);
  await pace(1500);
  const mine = await call(await as("customer"), "GET", "/api/notifications/centre?pageSize=20");
  const theirs = await call(await as(OWNER), "GET", "/api/notifications/centre?pageSize=20");
  const has = (r: Answer) => JSON.stringify(r.body ?? {}).includes(res.body.booking.bookingNumber);
  expect(has(mine), "customer notified").toBe(true);
  expect(has(theirs), "consultant notified").toBe(true);
  await act("customer", res.body.booking.id, "cancel", { reason: "QA clean-up" });
  return `${res.body.booking.bookingNumber} confirmed for ${start}; both notified; cancelled again`;
}, signed);

qa(["TC-CON-008"], "two customers asking for the same time at the same moment: exactly one gets it", async () => {
  const p = await practice();
  const start = await startAhead(p.services.free, 8, p.ownerMemberId);
  const [a, b] = await Promise.all([
    book("customer", { serviceId: p.services.free, memberId: p.ownerMemberId, start }),
    book("customer2", { serviceId: p.services.free, memberId: p.ownerMemberId, start }),
  ]);
  const statuses = [a.status, b.status].sort();
  expect(statuses, `${why(a)} / ${why(b)}`).toEqual([201, 409]);
  const loser = a.status === 409 ? a : b;
  expect(loser.body?.error?.message ?? "").toMatch(/just taken/);
  const winner = a.status === 201 ? { res: a, role: "customer" as Role } : { res: b, role: "customer2" as Role };
  await act(winner.role, winner.res.body.booking.id, "cancel", { reason: "QA clean-up" });
  return `201 and 409 for ${start}`;
}, signed);

qa(["TC-CON-009"], "another customer cannot see or cancel someone's booking (404)", async () => {
  const p = await practice();
  const start = await startAhead(p.services.free, 10, p.ownerMemberId);
  const res = await book("customer", { serviceId: p.services.free, memberId: p.ownerMemberId, start, note: "QA private note" });
  expectStatus(res, 201, "book");
  const id = res.body.booking.id;
  const peek = await bookingOf("customer2", id);
  const poke = await act("customer2", id, "cancel");
  expect([peek.status, poke.status]).toEqual([404, 404]);
  expect(peek.text).not.toContain("QA private note");
  expect((await bookingOf("customer", id)).body.card.status).toBe("CONFIRMED");
  const owner = await bookingOf(OWNER, id);
  expect(owner.status, "the consultant sees it").toBe(200);
  expect(owner.body.booking.customerNote).toBe("QA private note");
  expect(owner.body.completionCode, "no code for the consultant").toBeNull();
  await act("customer", id, "cancel");
  return "customer2: 404 / 404; owner sees the note but not the code";
}, signed);

qa(["TC-CON-010", "TC-CON-011"], "the customer moves a booking within the policy, then cancels; the time is offered again", async () => {
  const p = await practice();
  const first = await startAhead(p.services.free, 12, p.ownerMemberId);
  const res = await book("customer", { serviceId: p.services.free, memberId: p.ownerMemberId, start: first });
  expectStatus(res, 201, "book");
  const id = res.body.booking.id;
  const second = await startAhead(p.services.free, 14, p.ownerMemberId);
  const moved = await act("customer", id, "reschedule", { start: second });
  expectStatus(moved, 200, "reschedule");
  expect(moved.body.booking.rescheduleCount).toBe(1);
  const third = await startAhead(p.services.free, 15, p.ownerMemberId);
  expectStatus(await act("customer", id, "reschedule", { start: third }), 200, "second reschedule");
  const fourth = await startAhead(p.services.free, 16, p.ownerMemberId);
  const tooMany = await act("customer", id, "reschedule", { start: fourth });
  expect(tooMany.status, why(tooMany)).toBe(409);
  const cancelled = await act("customer", id, "cancel", { reason: "QA" });
  expectStatus(cancelled, 200, "cancel");
  expect(cancelled.body.booking.status).toBe("CANCELLED");
  expect(cancelled.body.booking.cancelledBy).toBe("CUSTOMER");
  const again = await freeStarts(p.services.free, { memberId: p.ownerMemberId, days: 3 });
  expect(again.some((s) => s.start === third), "the time is free again").toBe(true);
  return `moved twice, third move refused (${tooMany.status}), cancelled; ${third} free again`;
}, signed);

qa(["TC-CON-022"], "a group session takes people up to its capacity", async () => {
  const p = await practice();
  const slots = await freeStarts(p.services.group, { days: 3, attendees: 3 });
  const start = need(slots.find((s) => new Date(s.start).getTime() > Date.now() + 18 * 3_600_000 && s.places === 3)?.start, "an empty group session 18 h ahead");
  const a = await book("customer", { serviceId: p.services.group, start, attendees: 2 });
  expectStatus(a, 201, "2 places");
  const b = await book("customer2", { serviceId: p.services.group, start, attendees: 1 });
  expectStatus(b, 201, "1 place");
  const c = await book("customer2", { serviceId: p.services.group, start, attendees: 1 });
  expect(c.status, why(c)).toBe(409);
  for (const [role, r] of [["customer", a], ["customer2", b]] as const) await act(role, r.body.booking.id, "cancel");
  return `3 of 3 places taken at ${start}; the 4th refused`;
}, signed);

qa(["TC-CON-023"], "a team appointment holds two consultants; 'any available' picks the free one", async () => {
  const p = await practice();
  const start = await startAhead(p.services.team, 20);
  const team = await book("customer", { serviceId: p.services.team, memberId: null, start });
  expectStatus(team, 201, "team booking");
  const blockedOwner = await book("customer2", { serviceId: p.services.free, memberId: p.ownerMemberId, start });
  expect(blockedOwner.status, "owner is busy with the team booking").toBe(409);
  await act("customer", team.body.booking.id, "cancel");
  const start2 = await startAhead(p.services.free, 21, p.ownerMemberId);
  const one = await book("customer", { serviceId: p.services.free, memberId: p.ownerMemberId, start: start2 });
  expectStatus(one, 201, "owner booked");
  const any = await book("customer2", { serviceId: p.services.free, memberId: null, start: start2 });
  expectStatus(any, 201, "any available");
  const anyView = await bookingOf("customer2", any.body.booking.id);
  expect(anyView.body.card.members.map((m: { id: string }) => m.id)).toEqual([p.assistantId]);
  await act("customer", one.body.booking.id, "cancel");
  await act("customer2", any.body.booking.id, "cancel");
  return "team held both; 'any available' got the assistant";
}, signed);

/* ========================================================= consultant side */

qa(["TC-CON-012", "TC-CON-014"], "pay at the visit: the consultant records the payment, a receipt is issued; the calendar shows the booking", async ({ browser }) => {
  const p = await practice();
  const start = await startAhead(p.services.visit, 22, p.ownerMemberId);
  const res = await book("customer", { serviceId: p.services.visit, memberId: p.ownerMemberId, start, paymentMode: "PAY_AT_VISIT" });
  expectStatus(res, 201, "book");
  expect(res.body.booking.status).toBe("CONFIRMED");
  const id = res.body.booking.id;
  const day = new Date(new Date(start).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const cal = await firm(OWNER, p.shopId, "GET", undefined, `?view=calendar&from=${day}&to=${day}`);
  expectStatus(cal, 200, "calendar");
  expect((cal.body.bookings as { id: string }[]).some((b) => b.id === id), "booking in the calendar").toBe(true);
  const dash = await firm(OWNER, p.shopId, "GET", undefined, "?view=dashboard");
  expectStatus(dash, 200, "dashboard");
  expect(dash.body.upcomingCount).toBeGreaterThanOrEqual(1);
  const paid = await act(OWNER, id, "paid", { method: "UPI" });
  expectStatus(paid, 200, "mark paid");
  expect(paid.body.booking.paymentStatus).toBe("PAID");
  expect(paid.body.booking.receiptNumber).toMatch(/^GKC\/\d{4}-\d{2}\/\d{6}$/);
  const { context, page: customer } = await pageAs(browser, "customer");
  try {
    await customer.goto(`/consult/bookings/${id}/receipt`);
    await expect(customer.getByTestId("consult-receipt")).toBeVisible();
    await expect(customer.getByText(paid.body.booking.receiptNumber)).toBeVisible();
  } finally {
    await context.close();
  }
  await act(OWNER, id, "cancel", { reason: "QA clean-up" });
  return `receipt ${paid.body.booking.receiptNumber}; calendar and dashboard list it`;
}, signed);

qa(["TC-CON-013"], "completing an in-person appointment needs the customer's code; a wrong code is refused; then the customer rates it", async () => {
  const p = await practice();
  const soon = (await freeStarts(p.services.quick, { memberId: p.ownerMemberId, days: 1 })).find((s) => new Date(s.start).getTime() <= Date.now() + 14 * 60_000);
  const start = need(soon?.start, "a free 5-minute time within 14 minutes");
  const res = await book("customer", { serviceId: p.services.quick, memberId: p.ownerMemberId, start });
  expectStatus(res, 201, "book");
  const id = res.body.booking.id;
  const code = need((await bookingOf("customer", id)).body.completionCode as string | null, "the customer's completion code");
  const wrong = await act(OWNER, id, "complete", { code: code === "0000" ? "1111" : "0000" });
  expect(wrong.status, why(wrong)).toBe(422);
  expect(wrong.body?.error?.message ?? "").toMatch(/not right/);
  const done = await act(OWNER, id, "complete", { code });
  expectStatus(done, 200, "complete");
  expect(done.body.booking.status).toBe("COMPLETED");
  const rated = await act("customer", id, "rate", { rating: 5, review: "QA" });
  expectStatus(rated, 200, "rate");
  return `wrong code 422, right code → COMPLETED, rated 5`;
}, signed);

qa(["SC-50"], "journey: the customer finds the consultant, books paying at the visit; the consultant records the payment and completes with the customer's code; the customer rates", async () => {
  const p = await practice();
  const found = await call(await as("customer"), "GET", `/api/consult/search?q=${encodeURIComponent("QA Test Clinic")}`);
  expectStatus(found, 200, "search");
  expect((found.body.results as { shopId: string }[]).some((r) => r.shopId === p.shopId), "found by name").toBe(true);
  const soon = (await freeStarts(p.services.visit, { memberId: p.ownerMemberId, days: 1 })).find((s) => new Date(s.start).getTime() <= Date.now() + 14 * 60_000);
  const start = need(soon?.start, "a free 15-minute time within 14 minutes");
  const res = await book("customer", { serviceId: p.services.visit, memberId: p.ownerMemberId, start, paymentMode: "PAY_AT_VISIT" });
  expectStatus(res, 201, "book");
  expect(res.body.booking.status).toBe("CONFIRMED");
  const id = res.body.booking.id as string;
  const paid = await act(OWNER, id, "paid", { method: "UPI" });
  expectStatus(paid, 200, "record the payment");
  expect(paid.body.booking.paymentStatus).toBe("PAID");
  expect(paid.body.booking.receiptNumber).toMatch(/^GKC\/\d{4}-\d{2}\/\d{6}$/);
  const code = need((await bookingOf("customer", id)).body.completionCode as string | null, "the customer's completion code");
  const done = await act(OWNER, id, "complete", { code });
  expectStatus(done, 200, "complete");
  expect(done.body.booking.status).toBe("COMPLETED");
  const rated = await act("customer", id, "rate", { rating: 5, review: "QA journey" });
  expectStatus(rated, 200, "rate");
  return `found → booked (pay at visit) → paid ${paid.body.booking.receiptNumber} → COMPLETED with the code → rated 5`;
}, { ...signed, partial: "the commission line in the next payout and the rating on the public profile are checked by tests/integration/consult-bookings.test.ts" });

/* ============================================================ online money */

async function onlineBooking(hoursAhead: number) {
  const p = await practice();
  const start = await startAhead(p.services.online, hoursAhead, p.ownerMemberId);
  const res = await book("customer", { serviceId: p.services.online, memberId: p.ownerMemberId, start, paymentMode: "ONLINE" });
  expectStatus(res, 201, "book online");
  expect(res.body.booking.status).toBe("PENDING_PAYMENT");
  const url = String(res.body.checkoutUrl ?? "");
  const path = url.startsWith("http") ? new URL(url).pathname : url;
  if (!/^\/orders\/pay\/sandbox\//.test(path)) {
    await act("customer", res.body.booking.id, "cancel");
    blocked(`online payments on this site open ${url || "no page"} (not the sandbox gateway); pay with Cashfree sandbox test data through the "Sandbox payment" workflow`);
  }
  return { p, id: res.body.booking.id as string, path, start };
}

qa(["TC-CON-015", "TC-CON-010", "SC-51"], "online payment: the time is held, success confirms it with a receipt; cancelling early refunds it in full and frees the time", async ({ browser }) => {
  const { p, id, path, start } = await onlineBooking(24);
  const held = await bookingOf("customer", id);
  expect(held.body.booking.holdExpiresAt, "10-minute hold").toBeTruthy();
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto(path);
    const box = page.getByTestId("sandbox-checkout");
    await expect(box).toBeVisible();
    await box.getByLabel("UPI", { exact: true }).check();
    await box.getByTestId("sandbox-pay").click();
    await page.waitForURL(new RegExp(`/consult/bookings/${id}`), { timeout: 45_000 });
    await expect(page.getByTestId("consult-booking-view")).toBeVisible();
  } finally {
    await context.close();
  }
  const paid = await bookingOf("customer", id);
  expect(paid.body.card.status).toBe("CONFIRMED");
  expect(paid.body.card.paymentStatus).toBe("PAID");
  expect(paid.body.booking.receiptNumber).toBeTruthy();
  const cancelled = await act("customer", id, "cancel", { reason: "QA refund check" });
  expectStatus(cancelled, 200, "cancel");
  expect(cancelled.body.booking.refundPaise).toBe(100);
  const view = await bookingOf("customer", id);
  expect(["PENDING", "REFUNDED"]).toContain(view.body.refund.status);
  const again = await freeStarts(p.services.online, { memberId: p.ownerMemberId, days: 3 });
  expect(again.some((s) => s.start === start), "the cancelled time is offered again").toBe(true);
  return `paid ₹1 in the sandbox → CONFIRMED (${paid.body.booking.receiptNumber}); cancelled → ₹1 refund ${view.body.refund.status}; time offered again`;
}, signed);

qa(["TC-CON-016"], "a failed online payment frees the held time", async ({ browser }) => {
  const { p, id, path, start } = await onlineBooking(26);
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto(path);
    const box = page.getByTestId("sandbox-checkout");
    await expect(box).toBeVisible();
    await box.getByLabel("UPI", { exact: true }).check();
    await box.getByTestId("sandbox-fail").click();
    await page.waitForURL(new RegExp(`/consult/bookings/${id}`), { timeout: 45_000 });
  } finally {
    await context.close();
  }
  const after = await bookingOf("customer", id);
  expect(after.body.card.status).toBe("EXPIRED");
  expect(after.body.card.paymentStatus).toBe("FAILED");
  const again = await freeStarts(p.services.online, { memberId: p.ownerMemberId, days: 3 });
  expect(again.some((s) => s.start === start), "the time is offered again").toBe(true);
  return `failed payment → EXPIRED / FAILED; ${start} free again`;
}, signed);

/* ============================================================ staff, disputes */

qa(["TC-CON-017", "TC-CON-018"], "admin reads every booking, the report, categories and policies; customers and shop owners get 403", async () => {
  await practice();
  const admin = await as("admin");
  for (const view of ["bookings", "report", "categories", "templates", "profiles"]) {
    const res = await call(admin, "GET", `/api/admin/consult?view=${view}`);
    expectStatus(res, 200, `admin ${view}`);
  }
  const cats = await call(admin, "GET", "/api/admin/consult?view=categories");
  expect((cats.body.categories as unknown[]).length).toBeGreaterThanOrEqual(28);
  const tpl = await call(admin, "GET", "/api/admin/consult?view=templates");
  expect((tpl.body.templates as { name: string }[]).map((t) => t.name)).toEqual(expect.arrayContaining(["Standard", "Flexible", "Strict"]));
  const refused: string[] = [];
  for (const role of ["customer", "shop"] as Role[]) {
    for (const [method, body] of [["GET", undefined], ["POST", { action: "category", category: { name: `QA intruder ${RUN}` } }]] as const) {
      const res = await call(await as(role), method, `/api/admin/consult${method === "GET" ? "?view=bookings" : ""}`, body);
      expect(res.status, `${role} ${method} — ${why(res)}`).toBe(403);
      refused.push(`${role} ${method} 403`);
    }
  }
  return `admin: 5 views 200; ${refused.join(", ")}`;
}, signed);

qa(["TC-CON-025"], "'Report a problem' opens a help-desk ticket linked to the consultant; a second one is refused", async () => {
  const p = await practice();
  const start = await startAhead(p.services.free, 28, p.ownerMemberId);
  const res = await book("customer", { serviceId: p.services.free, memberId: p.ownerMemberId, start });
  expectStatus(res, 201, "book");
  const id = res.body.booking.id;
  const d = await act("customer", id, "dispute", { reason: `QA dispute check ${RUN}: please ignore and close.` });
  if (d.status === 409 && /help desk is not available/i.test(d.body?.error?.message ?? "")) blocked("the help desk is switched off on this site");
  expectStatus(d, 200, "dispute");
  expect(d.body.ticketNumber).toBeTruthy();
  const again = await act("customer", id, "dispute", { reason: "Second dispute should be refused" });
  expect(again.status).toBe(409);
  await act("customer", id, "cancel");
  return `ticket ${d.body.ticketNumber}; second dispute 409`;
}, signed);

qa(["TC-CON-003"], "a booking id that does not exist answers 404 to a signed-in customer", async () => {
  const res = await bookingOf("customer", NO_SUCH_ID);
  expect(res.status).toBe(404);
  return "404";
}, signed);

/* ============================================ not automated here (with the reason) */

manual(
  "TC-CON-006",
  "a doctor cannot publish without the council registration certificate; after the upload the profile publishes PENDING",
  "needs a practice that is not yet live and a certificate upload; the shared QA Test Clinic must stay live for the other checks. Proved by tests/integration/consult-bookings.test.ts (publish refused without the certificate, PENDING → VERIFIED after the upload)",
);
manual(
  "TC-CON-019",
  "admin adds and edits a category with its commission and required registration",
  "a category cannot be deleted, so each run would leave one more on the shared site. Proved by tests/integration/consult-bookings.test.ts (category with commission and RCI; a booking in it uses that commission); TC-CON-017 reads the categories as admin here",
);
manual(
  "TC-CON-020",
  "each role has its consultant entry on the Tile Board",
  "the entries for every role are checked by tests/unit/tile-board.test.ts (menu counts and the seven-per-group rule); a click-through per role is not automated yet",
);
manual(
  "TC-CON-026",
  "the apps show the module and a /consult link opens the Android app",
  "needs the Android / iOS app (1.9.0) on a phone",
);
