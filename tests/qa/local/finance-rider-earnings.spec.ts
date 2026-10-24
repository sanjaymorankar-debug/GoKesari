/**
 * Rider earnings on the local server (GS-063/064): the default rate on a
 * 3 km drop (TC-FIN-011), time-slot rates and "Try a delivery" (TC-FIN-012,
 * TC-FIN-013, TC-FLD-115), incentives paid once (TC-FIN-014), the minimum
 * top-up (TC-FIN-015), failed / cancelled-after-pickup pay (TC-FIN-016),
 * switching a slot off (TC-FIN-017) and recording a rider's COD cash deposit
 * (TC-FLD-117).
 *
 * Local tier: slots, incentives and the riderEarnings rule are global, so
 * every check starts from "no slot, no incentive" and the last check puts back
 * the ones that were active before. The leg distance an earning is paid on is
 * set on the offered leg (as routing would have measured it).
 */
import {
  api,
  asPage,
  buy,
  deliveredOrder,
  deliveryOver,
  earningOf,
  freeRider,
  freshListing,
  listingOf,
  packOrder,
  partnerId,
  pickUpAndStart,
  riderAction,
  rid,
  setRules,
  shopId,
  shown,
  withRules,
  type EarningLine,
} from "../lib/finance-helpers";
import { db } from "../lib/db";
import { offerFor } from "../lib/flows";
import { expectStatus, RUN, stash, unstash } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";

const local = { tier: "local" as const, timeout: 300_000 };
const K = (k: string) => `fin-earnings-${k}`;
const IST = { timezoneId: "Asia/Kolkata" };

/** "HH:MM" in IST, `offsetMin` minutes from now. */
function istClock(offsetMin = 0) {
  const d = new Date(Date.now() + 330 * 60_000 + offsetMin * 60_000);
  return d.toISOString().slice(11, 16);
}
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const lines = (l: EarningLine[]) => l.map((x) => `${x.component} ${x.amountPaise}`).join(", ");

async function preview(body: Record<string, unknown>) {
  const res = await api("admin", "POST", "/api/admin/rider-earnings/preview", body);
  expectStatus(res, 200, "earning preview");
  return res.body as { totalPaise: number; slotName: string | null; slotId: string | null; lines: EarningLine[] };
}

async function newSlot(body: Record<string, unknown>) {
  const res = await api("admin", "POST", "/api/admin/rider-earnings/slots", body);
  expectStatus(res, 201, `slot ${String(body.name)}`);
  return res.body as { id: string; name: string };
}

/** Switches off every slot and incentive this file created (and leaves the rest as the snapshot had them). */
async function clearOwnRules() {
  await db()`update rider_earning_slots set is_active = false where name like ${`QA %${RUN}%`} or name like 'QA %'`;
  await db()`update rider_incentive_rules set is_active = false where name like 'QA %'`;
}

qa("TC-FIN-011", "default rider earning: a 3 km drop pays ₹20 base + 3 × ₹8 = ₹44 with base and distance lines in the rider's statement", async ({ browser }) => {
  // Start: no slot, no incentive; the default rate and the riderEarnings rule at their code defaults.
  const slots = await db()<{ id: string }[]>`select id from rider_earning_slots where is_active`;
  const incentives = await db()<{ id: string }[]>`select id from rider_incentive_rules where is_active`;
  if (!unstash(K("snapshot"))) stash(K("snapshot"), { slots: slots.map((s) => s.id), incentives: incentives.map((i) => i.id) });
  await db()`update rider_earning_slots set is_active = false where is_active`;
  await db()`update rider_incentive_rules set is_active = false where is_active`;
  const config = await api("admin", "GET", "/api/delivery-partner/earnings-config");
  expectStatus(config, 200, "earnings config");
  if (config.body.baseFeePaise !== 2000 || config.body.perKmFeePaise !== 800) blocked(`the default rate on this site is base ${config.body.baseFeePaise} / per km ${config.body.perKmFeePaise} paise, not ₹20 / ₹8`);
  const restore = await setRules({ riderEarnings: { minimumEarningPaise: 0, failedDeliveryPayoutPercent: 100, cancelledAfterPickupPayoutPercent: 100, latePenaltyPaise: 0 } });
  try {
    const drop = await deliveryOver(3);
    const e = drop.earning;
    expect(e.totalPaise, `earning of a 3 km drop (${lines(e.lines)})`).toBe(4400);
    expect(e.lines.find((l) => l.component === "BASE")?.amountPaise, "base line").toBe(2000);
    expect(e.lines.find((l) => l.component === "DISTANCE")?.amountPaise, "distance line").toBe(2400);
    expect(e.lines.find((l) => l.component === "DISTANCE")?.description).toBe("Distance 3.0 km");
    await asPage(browser, "rider", "/delivery-partner", async (page) => {
      const card = page.getByTestId("rider-earnings");
      await expect(card.locator("li").filter({ hasText: drop.orderNumber })).toContainText(shown(4400));
    });
    return `${drop.orderNumber}: ₹44.00 = Base fee ₹20 + Distance 3.0 km ₹24 (statement lines), shown on /delivery-partner`;
  } finally {
    await restore();
  }
}, { ...local, mobile: true, partial: "the /delivery-partner page lists each earning's total; its breakdown lines are in the rider's statement (GET /api/delivery-partner/earnings), not on the page" });

qa("TC-FIN-012", "time-slot rate: Morning 06:00–11:00 (base ₹30, per km ₹5, peak bonus ₹10); 'Try a delivery' at 09:30 uses it, at 15:00 the default", async ({ browser }) => {
  const name = `QA Morning ${RUN}`;
  const out = await asPage(browser, "admin", "/admin/rider-earnings", async (page) => {
    const slots = page.locator("section").filter({ has: page.getByRole("heading", { name: "Earning slots" }) });
    await slots.getByLabel("Name (Morning, Evening…)").fill(name);
    await slots.getByLabel("From (HH:MM)").fill("06:00");
    await slots.getByLabel("To (HH:MM)").fill("11:00");
    await slots.getByLabel("Base fee ₹ (blank = default)").fill("30");
    await slots.getByLabel("Per km ₹ (blank = default)").fill("5");
    await slots.getByLabel("Peak bonus ₹").fill("10");
    await slots.getByRole("button", { name: "Add slot" }).click();
    await expect(slots.getByText(name)).toBeVisible();
    const tryIt = page.locator("section").filter({ has: page.getByRole("heading", { name: "Try a delivery" }) });
    const run = async (when: string) => {
      await tryIt.getByLabel("Distance (km)").fill("3");
      await tryIt.getByLabel("Order value ₹").fill("300");
      await tryIt.getByLabel("When (blank = now)").fill(when);
      const answered = page.waitForResponse((r) => r.url().includes("/api/admin/rider-earnings/preview"));
      await tryIt.getByRole("button", { name: "Calculate" }).click();
      const body = await (await answered).json();
      const result = tryIt.getByTestId("earning-preview");
      await expect(result).toContainText(shown(body.totalPaise));
      await expect(result).toContainText(body.slotName ?? "none (default rate)");
      return (await result.innerText()).replace(/\s+/g, " ");
    };
    const date = istToday();
    const morning = await run(`${date}T09:30`);
    const afternoon = await run(`${date}T15:00`);
    return { morning, afternoon };
  }, IST);
  expect(out.morning, "09:30 uses Morning").toContain(`Slot: ${name}`);
  expect(out.morning).toContain(`net ${shown(5500)}`);
  expect(out.morning).toContain(`Base fee (${name}) ${shown(3000)}`);
  expect(out.morning).toContain(`Distance 3.0 km ${shown(1500)}`);
  expect(out.morning).toContain(`Slot bonus (${name}) ${shown(1000)}`);
  expect(out.afternoon, "15:00 uses the default rate").toContain("Slot: none (default rate)");
  expect(out.afternoon).toContain(`net ${shown(4400)}`);
  await clearOwnRules();
  return `09:30 → "${out.morning.slice(0, 120)}"; 15:00 → "${out.afternoon.slice(0, 60)}"`;
}, local);

qa("TC-FIN-013", "an overnight slot 22:00–02:00 matches 23:30 and 01:00, not 03:00; of two overlapping slots the higher priority wins, within its weekday and date limits", async () => {
  const day = istToday();
  const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const night = await newSlot({ name: `QA Night ${RUN}`, startTime: "22:00", endTime: "02:00", baseFeePaise: 2500 });
  const results: string[] = [];
  try {
    for (const [d, t, want] of [[day, "23:30", true], [next, "01:00", true], [next, "03:00", false]] as const) {
      const p = await preview({ distanceKm: 1, orderSubtotalPaise: 10_000, at: at(d, t) });
      expect(p.slotId === night.id, `${t} → ${p.slotName ?? "default"}`).toBe(want);
      results.push(`${t} ${p.slotName ?? "default"}`);
    }
    await db()`update rider_earning_slots set is_active = false where id = ${night.id}`;
    // Overlap: a low-priority all-week slot and a high-priority one limited to one weekday and a date range.
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const wide = await newSlot({ name: `QA Wide ${RUN}`, startTime: "08:00", endTime: "12:00", baseFeePaise: 2100, priority: 1 });
    const narrow = await newSlot({ name: `QA Narrow ${RUN}`, startTime: "09:00", endTime: "10:00", baseFeePaise: 2900, priority: 5, daysOfWeek: [weekday], validFrom: day, validTo: day });
    const sameDay = await preview({ distanceKm: 1, orderSubtotalPaise: 10_000, at: at(day, "09:30") });
    expect(sameDay.slotId, "higher priority wins on its weekday / date").toBe(narrow.id);
    const nextWeek = new Date(Date.parse(`${day}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const outsideDates = await preview({ distanceKm: 1, orderSubtotalPaise: 10_000, at: at(nextWeek, "09:30") });
    expect(outsideDates.slotId, "same weekday, outside its dates → the wide slot").toBe(wide.id);
    const otherDay = await preview({ distanceKm: 1, orderSubtotalPaise: 10_000, at: at(next, "09:30") });
    expect(otherDay.slotId, "another weekday → the wide slot").toBe(wide.id);
    const outsideWindow = await preview({ distanceKm: 1, orderSubtotalPaise: 10_000, at: at(day, "11:30") });
    expect(outsideWindow.slotId, "outside the narrow window → the wide slot").toBe(wide.id);
    results.push(`overlap 09:30 ${sameDay.slotName}; next week ${outsideDates.slotName}; next day ${otherDay.slotName}; 11:30 ${outsideWindow.slotName}`);
  } finally {
    await clearOwnRules();
  }
  return results.join("; ");
}, local);

qa("TC-FLD-115", "slot fields: equal start and end, negative and text rates are refused; an overnight slot and an overlapping slot are accepted", async () => {
  const bad: string[] = [];
  const base = { name: `QA Field ${RUN}`, startTime: "10:00", endTime: "12:00" };
  try {
    const probes: [Record<string, unknown>, string, number][] = [
      [{ startTime: "10:00", endTime: "10:00" }, "end = start", 422],
      [{ baseFeePaise: -100 }, "base −₹1", 422],
      [{ perKmFeePaise: "five" }, "per km text", 422],
      [{ peakBonusPaise: -1 }, "peak bonus −1", 422],
      [{ startTime: "25:00" }, "start 25:00", 422],
      [{ startTime: "22:00", endTime: "06:00" }, "overnight 22:00–06:00", 201],
      [{ startTime: "11:00", endTime: "13:00", priority: 2 }, "overlapping 11:00–13:00", 201],
    ];
    let zeroAccepted = false;
    for (const [extra, label, want] of probes) {
      const res = await api("admin", "POST", "/api/admin/rider-earnings/slots", { ...base, ...extra });
      if (res.status !== want) bad.push(`${label} → ${res.status} (expected ${want})`);
    }
    const zero = await api("admin", "POST", "/api/admin/rider-earnings/slots", { ...base, baseFeePaise: 0 });
    zeroAccepted = zero.status === 201;
    expect(bad, bad.join("\n")).toEqual([]);
    return `equal times, negative, text and 25:00 → 422; overnight and overlapping → 201; a ₹0 base fee is ${zeroAccepted ? "accepted (a free base is a valid rate)" : "refused"}`;
  } finally {
    await clearOwnRules();
  }
}, local);

qa("TC-FIN-014", "incentives pay once when earned: daily target, order count, distance, peak hour and a dated campaign, each a separate ledger line", async () => {
  const rider = "rider2" as const;
  await freeRider(rider);
  const partner = await partnerId(rider);
  const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from delivery_orders where delivery_partner_id = ${partner} and status = 'DELIVERED'
    and (delivered_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date`;
  const created: string[] = [];
  const mk = async (body: Record<string, unknown>) => {
    const res = await api("admin", "POST", "/api/admin/rider-earnings/incentives", body);
    expectStatus(res, 201, `incentive ${String(body.name)}`);
    created.push(res.body.id);
    return res.body.id as string;
  };
  try {
    const daily = await mk({ name: "QA Daily 3", type: "DAILY_TARGET", thresholdValue: n + 3, rewardPaise: 5000 });
    await mk({ name: "QA Order count", type: "ORDER_COUNT", thresholdValue: n + 2, rewardPaise: 1000, period: "DAY" });
    await mk({ name: "QA Long trip", type: "DISTANCE", thresholdValue: 2500, rewardPaise: 700 });
    await mk({ name: "QA Peak", type: "PEAK_HOUR", startTime: istClock(-60), endTime: istClock(90), rewardPaise: 900 });
    await mk({ name: "QA Campaign", type: "CAMPAIGN", validFrom: istToday(), validTo: istToday(), rewardPaise: 300 });
    const drops: Awaited<ReturnType<typeof deliveryOver>>[] = [];
    for (const km of [2.6, 1, 1, 1]) drops.push(await deliveryOver(km, { rider }));
    const award = (e: { lines: EarningLine[] }, name: string) => e.lines.filter((l) => l.description === `Incentive: ${name}`).reduce((s, l) => s + l.amountPaise, 0);
    const table = drops.map((d, i) => ({
      i: n + i + 1,
      daily: award(d.earning, "QA Daily 3"),
      count: award(d.earning, "QA Order count"),
      distance: award(d.earning, "QA Long trip"),
      peak: award(d.earning, "QA Peak"),
      campaign: award(d.earning, "QA Campaign"),
    }));
    const want = [
      { daily: 0, count: 0, distance: 700, peak: 900, campaign: 300 },
      { daily: 0, count: 0, distance: 0, peak: 900, campaign: 300 },
      { daily: 5000, count: 1000, distance: 0, peak: 900, campaign: 300 },
      { daily: 0, count: 1000, distance: 0, peak: 900, campaign: 300 },
    ];
    table.forEach((row, i) => expect({ ...row, i: undefined }, `drop ${i + 1} of the day's new drops (${lines(drops[i].earning.lines)})`).toEqual({ ...want[i], i: undefined }));
    const [{ awards }] = await db()<{ awards: number }[]>`select count(*)::int as awards from rider_incentive_awards where rule_id = ${daily} and delivery_partner_id = ${partner}`;
    expect(awards, "the daily target is awarded once").toBe(1);
    return `rider 2 drops ${n + 1}–${n + 4} today: distance ₹7 on the 2.6 km drop; peak ₹9 and campaign ₹3 on each; order-count ₹10 on drops ${n + 3} and ${n + 4}; daily target ₹50 once (drop ${n + 3}), not again on drop ${n + 4}`;
  } finally {
    if (created.length) await db()`update rider_incentive_rules set is_active = false where id = any(${created})`;
  }
}, { ...local, timeout: 420_000, partial: "a weekly target (WEEKLY_TARGET) is the same rule with the ISO week as its period; it was not run here" });

qa("TC-FIN-015", "minimum earning ₹60: a short drop is topped up to ₹60 with a 'top-up' line", async () => {
  const drop = await withRules({ riderEarnings: { minimumEarningPaise: 6000 } }, () => deliveryOver(1));
  const e = drop.earning;
  expect(e.totalPaise, lines(e.lines)).toBe(6000);
  const top = e.lines.find((l) => l.component === "MIN_TOP_UP");
  expect(top?.amountPaise, "top-up = 60 − (20 + 8)").toBe(6000 - 2800);
  expect(top?.description).toBe("Top-up to the minimum earning of ₹60.00");
  return `${drop.orderNumber}: base ₹20 + 1 km ₹8 → top-up ₹32 → ₹60.00`;
}, local);

qa("TC-FIN-016", "failed drop at 50% pays half with a deduction line; at the default 100% in full; a cancel after pickup pays the rider in full", async () => {
  const failAt = async () => {
    await freeRider("rider");
    const order = await buy(listingOf("sharedA"), 1);
    await packOrder(order.id);
    const offer = await offerFor(order.id, "rider");
    await db()`update delivery_orders set distance_km = '1' where id = ${offer.deliveryOrderId}`;
    const leg = await pickUpAndStart(order.id);
    expectStatus(await riderAction(leg.deliveryOrderId, "fail", { reason: "QA: nobody at the door" }), 200, "fail the drop");
    return earningOf(leg.deliveryOrderId);
  };
  const half = await withRules({ riderEarnings: { failedDeliveryPayoutPercent: 50 } }, failAt);
  expect(half.totalPaise, lines(half.lines)).toBe(1400);
  const cut = half.lines.find((l) => l.component === "DEDUCTION");
  expect(cut?.amountPaise).toBe(-1400);
  expect(cut?.description).toBe("Only 50% paid for a failed delivery");
  const full = await failAt();
  expect(full.totalPaise, `default 100% (${lines(full.lines)})`).toBe(2800);
  expect(full.lines.some((l) => l.component === "DEDUCTION")).toBe(false);
  // The customer cancels after pickup: the rider is still paid in full (D10).
  await freeRider("rider");
  const order = await buy(listingOf("sharedA"), 1);
  await packOrder(order.id);
  const offer = await offerFor(order.id, "rider");
  await db()`update delivery_orders set distance_km = '1' where id = ${offer.deliveryOrderId}`;
  await pickUpAndStart(order.id);
  expectStatus(await api("customer", "PATCH", `/api/orders/${order.id}/status`, { status: "CANCELLED", note: "QA" }), 200, "customer cancels after pickup");
  const afterPickup = await earningOf(offer.deliveryOrderId);
  expect(afterPickup.totalPaise, lines(afterPickup.lines)).toBe(2800);
  return `failed at 50%: ₹14 with "Only 50% paid for a failed delivery" −₹14; failed at 100%: ₹28; cancelled after pickup: ₹28 (full)`;
}, local);

qa("TC-FIN-017", "switching a slot off does not rewrite history: the earlier earning keeps its slot lines, the next one uses the default", async ({ browser }) => {
  const name = `QA Now ${RUN}`;
  const slot = await newSlot({ name, startTime: istClock(-60), endTime: istClock(120), baseFeePaise: 3300 });
  try {
    const first = await deliveryOver(1);
    expect(first.earning.slotId, "earned under the slot").toBe(slot.id);
    expect(first.earning.lines.find((l) => l.component === "BASE")?.description).toBe(`Base fee (${name})`);
    await asPage(browser, "admin", "/admin/rider-earnings", async (page) => {
      const row = page.getByTestId("slot-row").filter({ hasText: name });
      await row.getByRole("button", { name: "Switch off" }).click();
      await expect(row.getByRole("button", { name: "Switch on" })).toBeVisible();
    });
    const second = await deliveryOver(1);
    expect(second.earning.slotId, "the next delivery ignores the switched-off slot").toBeNull();
    expect(second.earning.totalPaise).toBe(2800);
    const again = await earningOf(first.deliveryOrderId);
    expect(again.totalPaise, "past earning unchanged").toBe(first.earning.totalPaise);
    expect(again.lines.find((l) => l.component === "BASE")?.description, "past breakdown unchanged").toBe(`Base fee (${name})`);
    return `${first.orderNumber} ₹${first.earning.totalPaise / 100} under "${name}"; slot switched off on the page; ${second.orderNumber} ₹28 default; the first keeps its breakdown`;
  } finally {
    await clearOwnRules();
  }
}, local);

qa("TC-FLD-117", "COD cash deposit: blank, zero, negative, text, 3 decimals and more than the cash held are refused; ₹70.50 stored as 7050; a reference is required", async ({ browser }) => {
  const listing = await freshListing({ name: "QA COD ₹500", pricePaise: 50_000, stock: 5 });
  await db()`update shops set cod_enabled = true where id = ${shopId("A")}`;
  let cod;
  try {
    cod = await deliveredOrder({ listing, method: "COD" });
  } finally {
    await db()`update shops set cod_enabled = false where id = ${shopId("A")}`;
  }
  const partner = await partnerId("rider");
  const held = async () => {
    const res = await api("ops", "GET", "/api/admin/cod");
    expectStatus(res, 200, "cash held");
    return ((res.body as { party: string; id: string; heldPaise: number }[]).find((h) => h.party === "RIDER" && h.id === partner)?.heldPaise ?? 0) as number;
  };
  const start = await held();
  const holds = `Holds ${shown(start)}`;
  expect(start, "the rider holds at least the ₹500 just collected").toBeGreaterThanOrEqual(cod.totalPaise);
  const post = (amountPaise: unknown, reference: unknown = `RCPT-${RUN}`) => api("ops", "POST", "/api/admin/cod", { party: "RIDER", id: partner, amountPaise, reference, requestId: rid("dep") });
  const bad: string[] = [];
  for (const [v, label] of [[null, "blank"], [0, "0"], [-100, "negative"], ["abc", "text"], [1055.5, "10.555"], [10_000_000_000, "₹10,00,00,000"], [start + 1, "held + 1 paisa"]] as const) {
    const res = await post(v);
    if (![409, 422].includes(res.status)) bad.push(`amount ${label} → ${res.status}`);
  }
  const noRef = await post(7050, "");
  if (noRef.status !== 422) bad.push(`blank reference → ${noRef.status}`);
  // Through the form: ₹70.50.
  const aboveHeldBlocked = await asPage(browser, "ops", "/admin/cod", async (page) => {
    const row = page.getByTestId("cod-holders").locator(":scope > div").filter({ hasText: holds });
    await row.getByLabel("Amount (₹)").fill("70.50");
    await row.getByLabel("Receipt / reference").fill(`RCPT-${RUN}-1`);
    await row.getByRole("button", { name: "Record deposit" }).click();
    await expect(page.getByText("Deposit recorded.")).toBeVisible();
    // More than held: the button stays off.
    const left = `Holds ${shown(start - 7050)}`;
    const row2 = page.getByTestId("cod-holders").locator(":scope > div").filter({ hasText: left });
    await row2.getByLabel("Amount (₹)").fill(String((start - 7050 + 1) / 100));
    await row2.getByLabel("Receipt / reference").fill(`RCPT-${RUN}-2`);
    const blockedAbove = await row2.getByRole("button", { name: "Record deposit" }).isDisabled();
    await row2.getByLabel("Amount (₹)").fill("10.555");
    const threeDecimalsOpen = await row2.getByRole("button", { name: "Record deposit" }).isEnabled();
    if (threeDecimalsOpen) bad.push("the form accepts ₹10.555 without a field message (it would record 1056 paise)");
    return blockedAbove;
  });
  const [dep] = await db()<{ amount: number }[]>`select amount_paise::int as amount from financial_adjustments where type = 'COD_CASH_DEPOSITED' and reason like ${`%RCPT-${RUN}-1%`}`;
  if (dep?.amount !== 7050) bad.push(`₹70.50 stored as ${dep?.amount}`);
  if (!aboveHeldBlocked) bad.push("the form lets a deposit above the cash held be sent");
  expect(await held(), "held cash falls by the deposit").toBe(start - 7050);
  expect(bad, bad.join("\n")).toEqual([]);
  return `rider held ₹${start / 100}: blank / 0 / negative / text / 10.555 / ₹10 crore / held + 1 paisa → refused; blank reference → 422; ₹70.50 through the form → 7050 paise; above-held keeps the button off`;
}, local);

qa("TC-FIN-017", "the slots and incentives active before this file are put back", async () => {
  const snap = unstash<{ slots: string[]; incentives: string[] }>(K("snapshot"));
  await clearOwnRules();
  if (!snap) return "no snapshot (nothing was active before)";
  if (snap.slots.length) await db()`update rider_earning_slots set is_active = true where id = any(${snap.slots})`;
  if (snap.incentives.length) await db()`update rider_incentive_rules set is_active = true where id = any(${snap.incentives})`;
  stash(K("snapshot"), null);
  return `${snap.slots.length} slots and ${snap.incentives.length} incentives active again`;
}, local);
