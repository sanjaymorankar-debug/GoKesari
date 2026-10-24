/**
 * Subscriptions as the customer manages them (TC-SUB-001, 003, 004, 006–009,
 * 011, 012, 016, 019, TC-FLD-107–109): creating one from the shop page with
 * its cost preview, weekly schedules, a one-day quantity change, skipping,
 * pausing, cancelling, drafts, the locked final states, the dates that can
 * no longer be changed, who may open a subscription, and the field checks.
 *
 * Signed tier: only the customer's own subscriptions (each check cancels the
 * ones it made). Everything that needs the daily-orders job (CRON_SECRET) is
 * in tests/qa/local/money-subscriptions.spec.ts.
 */
import { as, pageAs } from "../lib/actors";
import { defaultAddress } from "../lib/flows";
import { anonymous, call, expectStatus, why } from "../lib/http";
import {
  calendar,
  cancelSubscriptionQuietly,
  createSubscription,
  history,
  istDate,
  isoWeekday,
  newMilkSubscription,
  notificationsOf,
  subscription,
  walletOf,
  worldListing,
} from "../lib/money-helpers";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 240_000 };

qa("TC-SUB-001", "subscribe to milk from the shop page: 2 L/day previews ₹140 per delivery and ₹980 for 7 days; the subscription opens ACTIVE", async ({ browser }) => {
  const milk = await worldListing("milk");
  const shop = need(world().shops.A, "shop A");
  const { context, page } = await pageAs(browser, "customer");
  let id = "";
  try {
    await page.goto(`/shops/${shop.slug}`);
    const card = page.getByRole("article").filter({ hasText: milk.name }).first();
    const fallback = page.locator("div").filter({ hasText: milk.name }).filter({ has: page.getByRole("button", { name: "Subscribe" }) }).last();
    const target = (await card.count()) ? card : fallback;
    await target.getByRole("button", { name: "Subscribe" }).click();
    await page.waitForURL(/\/subscribe\//);
    const unit = page.getByRole("button", { name: /Increase by 0\.5/ });
    await unit.click();
    await unit.click();
    await expect(page.getByText("2", { exact: true }).first()).toBeVisible();
    const preview = page.locator("dl");
    await expect(preview).toContainText("Per delivery");
    await expect(preview.locator("div").filter({ hasText: "Per delivery" })).toContainText("140");
    await expect(preview.locator("div").filter({ hasText: "7 days" })).toContainText("980");
    const created = page.waitForResponse((r) => r.url().endsWith("/api/subscriptions") && r.request().method() === "POST");
    await page.getByRole("button", { name: new RegExp(`^Subscribe to `) }).click();
    const res = await created;
    const body = await res.json();
    expect(res.status(), JSON.stringify(body).slice(0, 200)).toBe(201);
    id = body.id;
    await page.waitForURL(new RegExp(`/subscriptions/${id}`));
    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
  } finally {
    await context.close();
  }
  const sub = await subscription("customer", id);
  expect(sub.status).toBe("ACTIVE");
  expect(sub.quantityMilli).toBe(2000);
  const days = await calendar("customer", id, 3);
  const first = days.find((d) => d.delivers);
  expect(first?.estimatedCostPaise, "₹140 per delivery").toBe(14000);
  await cancelSubscriptionQuietly("customer", id);
  return `/subscribe for ${milk.name}: 1 L +0.5 +0.5 = 2 L; preview ₹140 per delivery, ₹980 for 7 days; Subscribe → /subscriptions/${id.slice(0, 8)}… "Active"; calendar ₹140 per delivery`;
}, { ...signed, mobile: true });

qa("TC-SUB-003", "a weekly Mon/Wed/Fri subscription delivers only on those days with the estimated cost; weekly with no weekday is refused", async () => {
  const sub = await newMilkSubscription("customer", { frequency: "WEEKLY", weekdays: [1, 3, 5], quantityMilli: 1000 });
  try {
    const days = await calendar("customer", sub.id, 14);
    const wrong = days.filter((d) => d.delivers !== [1, 3, 5].includes(isoWeekday(d.date)) && d.reason !== "BEFORE_START");
    expect(wrong.map((d) => `${d.date} (${isoWeekday(d.date)}) delivers=${d.delivers}`), "deliveries only on Mon/Wed/Fri").toEqual([]);
    for (const d of days.filter((x) => x.delivers)) expect(d.estimatedCostPaise, d.date).toBe(7000);
    const none = await createSubscription("customer", { shopProductId: sub.milk.shopProductId, quantityMilli: 1000, frequency: "WEEKLY", weekdays: [], startDate: istDate(1) });
    expect(none.status, why(none)).toBe(422);
    return `14 days: ${days.filter((d) => d.delivers).map((d) => d.date.slice(5)).join(", ")} at ₹70 each; WEEKLY with no weekday → 422 "${none.body?.error?.message}"`;
  } finally {
    await cancelSubscriptionQuietly("customer", sub.id);
  }
}, { ...signed, partial: "read from the calendar API the page draws (the page's day tiles are the same data)" });

qa("TC-SUB-004", "change tomorrow's quantity only: 3 L tomorrow (₹210, overridden), 2 L the day after; removing the override restores 2 L", async () => {
  const sub = await newMilkSubscription("customer", { startDate: istDate(1) });
  const tomorrow = istDate(1);
  const after = istDate(2);
  try {
    const set = await call(await as("customer"), "POST", `/api/subscriptions/${sub.id}/override`, { date: tomorrow, quantityMilli: 3000 });
    expectStatus(set, [200, 201], "override tomorrow");
    let days = await calendar("customer", sub.id, 4);
    const t = days.find((d) => d.date === tomorrow)!;
    const n = days.find((d) => d.date === after)!;
    expect([t.quantityMilli, t.estimatedCostPaise, t.isOverridden]).toEqual([3000, 21000, true]);
    expect([n.quantityMilli, n.estimatedCostPaise, n.isOverridden]).toEqual([2000, 14000, false]);
    const clear = await call(await as("customer"), "DELETE", `/api/subscriptions/${sub.id}/override`, { date: tomorrow });
    expectStatus(clear, 200, "remove the override");
    days = await calendar("customer", sub.id, 4);
    const back = days.find((d) => d.date === tomorrow)!;
    expect([back.quantityMilli, back.isOverridden]).toEqual([2000, false]);
    return `${tomorrow}: 3 L ₹210 overridden; ${after}: 2 L ₹140; override removed → ${tomorrow} 2 L`;
  } finally {
    await cancelSubscriptionQuietly("customer", sub.id);
  }
}, { ...signed, partial: "set through the API the day panel calls; the page's own tile wording is not asserted" });

qa("TC-SUB-006", "pause from D+2 to D+5: no deliveries inside the window (inclusive); resume restores them; notices and history for each", async () => {
  const sub = await newMilkSubscription("customer", { startDate: istDate(1) });
  const since = Date.now();
  try {
    const from = istDate(2);
    const until = istDate(5);
    expectStatus(await call(await as("customer"), "POST", `/api/subscriptions/${sub.id}/pause`, { from, until }), 200, "pause");
    let days = await calendar("customer", sub.id, 8);
    const inside = days.filter((d) => d.date >= from && d.date <= until);
    expect(inside.length).toBe(4);
    expect(inside.filter((d) => d.delivers).map((d) => d.date), "nothing delivered in the window").toEqual([]);
    expect(days.find((d) => d.date === istDate(1))?.delivers, "D+1 still delivers").toBe(true);
    expect(days.find((d) => d.date === istDate(6))?.delivers, "D+6 delivers again").toBe(true);
    expectStatus(await call(await as("customer"), "POST", `/api/subscriptions/${sub.id}/resume`, {}), 200, "resume");
    days = await calendar("customer", sub.id, 8);
    expect(days.filter((d) => d.date >= from && d.date <= until && d.delivers).length, "restored").toBe(4);
    const notes = (await notificationsOf("customer")).notifications.filter((n) => new Date(n.createdAt).getTime() >= since - 3000).map((n) => n.title);
    expect(notes).toContain("Subscription paused");
    expect(notes).toContain("Subscription resumed");
    const rows = (await history("customer", sub.id)).map((h) => h.action);
    expect(rows).toEqual(expect.arrayContaining(["PAUSED", "RESUMED"]));
    return `pause ${from}..${until} → 4 days without delivery, D+1 and D+6 deliver; resume → 4 days back; notices: ${notes.join(", ")}; history: ${rows.join(", ")}`;
  } finally {
    await cancelSubscriptionQuietly("customer", sub.id);
  }
}, { ...signed, partial: "pause and resume are sent through the API the subscription page's Pause / Resume buttons call; the calendar is read from its API" });

qa("TC-SUB-007", "cancel a subscription on its page: CANCELLED, no further deliveries, a notification", async ({ browser }) => {
  const sub = await newMilkSubscription("customer", { startDate: istDate(1) });
  const since = Date.now();
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto(`/subscriptions/${sub.id}`);
    await page.getByRole("button", { name: "Cancel subscription" }).click();
    const done = page.waitForResponse((r) => r.url().endsWith(`/api/subscriptions/${sub.id}`) && r.request().method() === "DELETE");
    await page.getByRole("button", { name: "Yes, cancel it" }).click();
    expect((await done).status()).toBe(200);
    await expect(page.getByText("Cancelled", { exact: false }).first()).toBeVisible();
  } finally {
    await context.close();
  }
  const s = await subscription("customer", sub.id);
  expect(s.status).toBe("CANCELLED");
  expect(s.nextDeliveryDate, "no next delivery").toBeNull();
  const days = await calendar("customer", sub.id, 7);
  expect(days.filter((d) => d.delivers).length, "no further deliveries").toBe(0);
  const note = (await notificationsOf("customer")).notifications.find((n) => n.title === "Subscription cancelled" && new Date(n.createdAt).getTime() >= since - 3000);
  expect(note, "cancellation notice").toBeTruthy();
  const rows = await history("customer", sub.id);
  return `page → "Cancel subscription" → "Yes, cancel it" → CANCELLED, next delivery none, calendar empty; "${note!.body}"; history ${rows.map((r) => `${r.action}${r.note ? ` (${r.note})` : ""}`).join(", ")}`;
}, { ...signed, mobile: true, partial: "the page sends a fixed reason ('Cancelled by customer'); a reason of the customer's own is only possible through the API" });

qa("TC-SUB-008", "a CANCELLED subscription is locked: pause, resume, skip and PATCH are refused and resume does not revive it", async () => {
  const sub = await newMilkSubscription("customer", { startDate: istDate(1) });
  await cancelSubscriptionQuietly("customer", sub.id);
  const c = await as("customer");
  const tries: [string, Promise<{ status: number; body: unknown }>][] = [
    ["pause", call(c, "POST", `/api/subscriptions/${sub.id}/pause`, { from: istDate(2), until: istDate(3) })],
    ["resume", call(c, "POST", `/api/subscriptions/${sub.id}/resume`, {})],
    ["skip", call(c, "POST", `/api/subscriptions/${sub.id}/skip`, { date: istDate(2) })],
    ["PATCH", call(c, "PATCH", `/api/subscriptions/${sub.id}`, { quantityMilli: 3000 })],
    ["activate", call(c, "POST", `/api/subscriptions/${sub.id}/activate`, {})],
  ];
  const out: string[] = [];
  const problems: string[] = [];
  for (const [what, p] of tries) {
    const res = await p;
    out.push(`${what} → ${res.status}`);
    if (res.status !== 409) problems.push(`${what} on a cancelled subscription answered ${res.status}`);
  }
  const s = await subscription("customer", sub.id);
  if (s.status !== "CANCELLED") problems.push(`status became ${s.status}`);
  if (s.quantityMilli !== 2000) problems.push(`the PATCH changed the cancelled subscription's quantity to ${s.quantityMilli}`);
  expect(problems, `${problems.join("; ")} — ${out.join(", ")}`).toEqual([]);
  return `${out.join(", ")}; still CANCELLED, quantity unchanged`;
}, signed);

qa("TC-SUB-009", "a past date cannot be skipped or have its quantity changed", async () => {
  const sub = await newMilkSubscription("customer", { startDate: istDate(0) });
  const c = await as("customer");
  try {
    const skip = await call(c, "POST", `/api/subscriptions/${sub.id}/skip`, { date: istDate(-1) });
    const over = await call(c, "POST", `/api/subscriptions/${sub.id}/override`, { date: istDate(-1), quantityMilli: 3000 });
    const clear = await call(c, "DELETE", `/api/subscriptions/${sub.id}/override`, { date: istDate(-1) });
    expect(skip.status, why(skip)).toBe(422);
    expect(over.status, why(over)).toBe(422);
    expect(clear.status, why(clear)).toBe(422);
    return `yesterday: skip → 422 "${skip.body?.error?.message}", override → 422, clear override → 422`;
  } finally {
    await cancelSubscriptionQuietly("customer", sub.id);
  }
}, { ...signed, partial: "a date already generated (processed) is TC-SUB-009 in tests/qa/local/money-subscriptions.spec.ts (needs the daily job)" });

qa("TC-FLD-109", "skip date and one-day quantity fields: past refused, today and future accepted, blank / impossible dates / text refused with 422, quantity 0 refused the same way every time", async () => {
  const sub = await newMilkSubscription("customer", { startDate: istDate(0) });
  const c = await as("customer");
  const out: string[] = [];
  const problems: string[] = [];
  const expectCode = (label: string, status: number, want: number | number[]) => {
    const list = Array.isArray(want) ? want : [want];
    out.push(`${label} → ${status}`);
    if (!list.includes(status)) problems.push(`${label}: expected ${list.join("/")}, got ${status}`);
  };
  try {
    expectCode("skip yesterday", (await call(c, "POST", `/api/subscriptions/${sub.id}/skip`, { date: istDate(-1) })).status, 422);
    expectCode("override yesterday", (await call(c, "POST", `/api/subscriptions/${sub.id}/override`, { date: istDate(-1), quantityMilli: 3000 })).status, 422);
    expectCode("skip today", (await call(c, "POST", `/api/subscriptions/${sub.id}/skip`, { date: istDate(0) })).status, [200, 201]);
    expectCode("skip D+3", (await call(c, "POST", `/api/subscriptions/${sub.id}/skip`, { date: istDate(3) })).status, [200, 201]);
    expectCode("skip blank", (await call(c, "POST", `/api/subscriptions/${sub.id}/skip`, { date: "" })).status, 422);
    expectCode("skip 31 February", (await call(c, "POST", `/api/subscriptions/${sub.id}/skip`, { date: `${istDate(0).slice(0, 4)}-02-31` })).status, 422);
    expectCode("skip text", (await call(c, "POST", `/api/subscriptions/${sub.id}/skip`, { date: "next friday" })).status, 422);
    for (let i = 0; i < 2; i++) expectCode(`tomorrow quantity 0 (try ${i + 1})`, (await call(c, "POST", `/api/subscriptions/${sub.id}/override`, { date: istDate(1), quantityMilli: 0 })).status, 422);
    const days = await calendar("customer", sub.id, 5);
    if (days.find((d) => d.date === istDate(3))?.reason !== "SKIPPED") problems.push("D+3 not shown as skipped");
  } finally {
    await cancelSubscriptionQuietly("customer", sub.id);
  }
  expect(problems, `${problems.join("; ")} — ${out.join(", ")}`).toEqual([]);
  return out.join(", ");
}, { ...signed, partial: "'skip a date already processed' is TC-SUB-009 in the local tier; the calendar page's day panel sends the same API calls" });

qa("TC-SUB-012", "a customer's subscription is closed to a shop owner, a rider and a society admin (API and page)", async ({ browser }) => {
  const sub = await newMilkSubscription("customer", { startDate: istDate(1) });
  const out: string[] = [];
  try {
    for (const role of ["shop", "rider", "society"] as const) {
      if (!world().users[role]) {
        out.push(`${role}: not in this site's test data`);
        continue;
      }
      const res = await call(await as(role), "GET", `/api/subscriptions/${sub.id}`);
      expect([403, 404], `${role} API — ${why(res)}`).toContain(res.status);
      const cal = await call(await as(role), "GET", `/api/subscriptions/${sub.id}/calendar`);
      expect([403, 404], `${role} calendar`).toContain(cal.status);
      const pause = await call(await as(role), "POST", `/api/subscriptions/${sub.id}/pause`, { from: istDate(2), until: istDate(3) });
      expect([403, 404], `${role} pause`).toContain(pause.status);
      const { context, page } = await pageAs(browser, role);
      try {
        const nav = await page.goto(`/subscriptions/${sub.id}`);
        const status = nav?.status() ?? 0;
        const shown = await page.getByText(sub.milk.name).count();
        expect(status === 404 || shown === 0 || /\/signin|\/$/.test(new URL(page.url()).pathname), `${role} page shows the subscription (HTTP ${status})`).toBe(true);
        out.push(`${role}: API ${res.status}, calendar ${cal.status}, pause ${pause.status}, page ${status}`);
      } finally {
        await context.close();
      }
    }
    const guest = await anonymous();
    const g = await call(guest, "GET", `/api/subscriptions/${sub.id}`);
    await guest.dispose();
    expect([401, 403]).toContain(g.status);
    out.push(`guest: ${g.status}`);
    expect((await subscription("customer", sub.id)).pauseFrom, "nothing changed").toBeNull();
  } finally {
    await cancelSubscriptionQuietly("customer", sub.id);
  }
  return out.join("; ");
}, signed);

qa("TC-SUB-016", "a draft subscription: saved as DRAFT with no orders or charges, ACTIVE after confirming", async ({ browser }) => {
  const milk = await worldListing("milk");
  const before = (await walletOf("customer")).wallet.balancePaise;
  const { context, page } = await pageAs(browser, "customer");
  let id = "";
  try {
    await page.goto(`/subscribe/${milk.shopProductId}`);
    const created = page.waitForResponse((r) => r.url().endsWith("/api/subscriptions") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Save as draft/ }).click();
    const res = await created;
    id = (await res.json()).id;
    await page.waitForURL(new RegExp(`/subscriptions/${id}`));
    await expect(page.getByTestId("subscription-draft")).toBeVisible();
    const s = await subscription("customer", id);
    expect(s.status).toBe("DRAFT");
    expect(s.nextDeliveryDate, "a draft schedules nothing").toBeNull();
    expect((await walletOf("customer")).wallet.balancePaise, "no charge").toBe(before);
    const activated = page.waitForResponse((r) => r.url().endsWith(`/api/subscriptions/${id}/activate`));
    await page.getByTestId("subscription-draft").getByRole("button").first().click();
    expect((await activated).status()).toBe(200);
  } finally {
    await context.close();
  }
  const s = await subscription("customer", id);
  expect(s.status).toBe("ACTIVE");
  expect(s.nextDeliveryDate).toBeTruthy();
  const rows = (await history("customer", id)).map((h) => h.action);
  await cancelSubscriptionQuietly("customer", id);
  return `"Save as draft" → DRAFT (no next delivery, wallet ${before} unchanged); activate → ACTIVE, next ${s.nextDeliveryDate}; history ${rows.join(", ")}`;
}, { ...signed, mobile: true, partial: "'no orders' for a draft on its delivery day is TC-SUB-019 in the local tier (daily job)" });

qa("TC-SUB-019", "drafts and final states cannot be moved by the API: pausing or resuming a draft, activating an active one, resuming a cancelled one", async () => {
  const draft = await newMilkSubscription("customer", { draft: true });
  const active = await newMilkSubscription("customer");
  const c = await as("customer");
  const out: string[] = [];
  try {
    for (const [what, res] of [
      ["pause a DRAFT", await call(c, "POST", `/api/subscriptions/${draft.id}/pause`, { from: istDate(2), until: istDate(3) })],
      ["resume a DRAFT", await call(c, "POST", `/api/subscriptions/${draft.id}/resume`, {})],
      ["activate an ACTIVE", await call(c, "POST", `/api/subscriptions/${active.id}/activate`, {})],
    ] as const) {
      expect(res.status, `${what} — ${why(res)}`).toBe(409);
      out.push(`${what} → 409`);
    }
    await cancelSubscriptionQuietly("customer", active.id);
    const revive = await call(c, "POST", `/api/subscriptions/${active.id}/resume`, {});
    expect(revive.status, "resume a CANCELLED").toBe(409);
    out.push("resume a CANCELLED → 409");
    expect((await subscription("customer", draft.id)).status).toBe("DRAFT");
    expect((await subscription("customer", active.id)).status).toBe("CANCELLED");
  } finally {
    await cancelSubscriptionQuietly("customer", draft.id);
    await cancelSubscriptionQuietly("customer", active.id);
  }
  return `${out.join(", ")}; states unchanged`;
}, { ...signed, partial: "there is no API that sets a status directly, so 'DRAFT → FULFILLED' and 'COMPLETED → ACTIVE' are tried through every action that could move them; the daily-job half (a draft never creates an order) is local" });

qa("TC-FLD-107", "quantity per delivery: blank, 0, negative, text and 1000 L refused; 0.5 L and 2 L accepted with cost = quantity × price; 2.3 L (off the 0.5 L step) refused", async () => {
  const milk = await worldListing("milk");
  const price = need(milk.pricePaise, "a priced milk listing");
  const address = await defaultAddress("customer");
  const base = { shopProductId: milk.shopProductId, frequency: "DAILY", weekdays: [], startDate: istDate(1), addressId: address?.id ?? null };
  const out: string[] = [];
  const problems: string[] = [];
  const made: string[] = [];
  try {
    for (const [label, q, accept] of [
      ["blank", undefined, false],
      ["0", 0, false],
      ["negative", -1000, false],
      ["text", "two", false],
      ["0.5 L", 500, true],
      ["2 L", 2000, true],
      ["2.3 L", 2300, false],
      ["1000 L", 1_000_000, false],
    ] as const) {
      const res = await createSubscription("customer", { ...base, ...(q === undefined ? {} : { quantityMilli: q }) });
      out.push(`${label} → ${res.status}`);
      if (res.status === 201) made.push(String(res.body.id));
      if (accept && res.status !== 201) problems.push(`${label} should be accepted (${res.status})`);
      if (!accept && res.status === 201) problems.push(`${label} was accepted`);
      if (!accept && res.status >= 500) problems.push(`${label}: server error`);
      if (res.status === 201 && typeof q === "number") {
        const day = (await calendar("customer", String(res.body.id), 3)).find((d) => d.delivers);
        const want = Math.round((price * q) / 1000);
        if (day?.estimatedCostPaise !== want) problems.push(`${label}: cost ${day?.estimatedCostPaise} ≠ ${want}`);
        else out[out.length - 1] += ` (₹${want / 100}/delivery)`;
      }
    }
  } finally {
    for (const id of made) await cancelSubscriptionQuietly("customer", id);
  }
  expect(problems, `${problems.join("; ")} — ${out.join(", ")}`).toEqual([]);
  return out.join(", ");
}, { ...signed, partial: "the page itself only steps in 0.5 L (−0.5 stops at 0.5, no free text), so the off-step and out-of-range values reach the server only through the API" });

qa("TC-FLD-108", "schedule and start date: blank, 31 February and text refused (not a server error); a past start date refused; today and future accepted; weekly needs a weekday", async () => {
  const milk = await worldListing("milk");
  const address = await defaultAddress("customer");
  const base = { shopProductId: milk.shopProductId, quantityMilli: 1000, frequency: "DAILY", weekdays: [], addressId: address?.id ?? null };
  const out: string[] = [];
  const problems: string[] = [];
  const made: string[] = [];
  try {
    for (const [label, startDate, accept] of [
      ["blank", "", false],
      ["past (yesterday)", istDate(-1), false],
      ["today", istDate(0), true],
      ["future (D+3)", istDate(3), true],
      ["31 February", `${istDate(0).slice(0, 4)}-02-31`, false],
      ["text", "tomorrow", false],
    ] as const) {
      const res = await createSubscription("customer", { ...base, startDate });
      out.push(`${label} → ${res.status}`);
      if (res.status === 201) made.push(String(res.body.id));
      if (accept && res.status !== 201) problems.push(`${label} should be accepted (${res.status} ${why(res)})`);
      if (!accept && res.status === 201) problems.push(`${label} was accepted`);
      if (!accept && res.status >= 500) problems.push(`${label}: server error ${res.status} instead of a 422`);
    }
    const weekly = await createSubscription("customer", { ...base, frequency: "WEEKLY", weekdays: [], startDate: istDate(1) });
    out.push(`weekly with no weekday → ${weekly.status}`);
    if (weekly.status !== 422) problems.push(`weekly with no weekday → ${weekly.status}`);
  } finally {
    for (const id of made) await cancelSubscriptionQuietly("customer", id);
  }
  expect(problems, `${problems.join("; ")} — ${out.join(", ")}`).toEqual([]);
  return out.join(", ");
}, { ...signed, partial: "the page's date box has min = today, but the page sends whatever date is typed; the API answer is the one checked here" });
