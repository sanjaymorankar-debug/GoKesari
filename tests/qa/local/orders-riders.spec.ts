/**
 * Rider onboarding and profile (package 5, "Rider delivery & handover" and
 * the rider field cases): the application form, operations review in the
 * console, the partner lifecycle through a real job, the gig portal pages,
 * self-edit of vehicle and bank details (F2: identity / bank changes go to an
 * operator for review), identity documents (C5) and the field-level rules of
 * the application.
 *
 * Local tier: every check uses brand-new accounts (created in the local
 * database with a session minted from the local AUTH_SECRET), reads the
 * stored rows and audit entries from the database, and puts the world's
 * riders back online when it moved them.
 */
import type { APIRequestContext, Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import {
  abandon,
  buyerCode,
  call,
  cron,
  driveTo,
  ensureWallet,
  expectStatus,
  freshAgain,
  freshCustomer,
  freshPage,
  freshRider,
  homeSpot,
  keep,
  kept,
  noRiderOnline,
  PDF_BYTES,
  pickupCode,
  placeSimple,
  png,
  poll,
  ridersOnlyOnline,
  TEXT,
  upload,
  type Answer,
  type FreshUser,
} from "../lib/orders-helpers";
import { expect, need, qa } from "../lib/record";

const local = { tier: "local" as const, timeout: 300_000 };

type Rider = FreshUser & { partnerId: string };

/* ------------------------------------------------------------ helpers */

interface PartnerRow {
  status: string;
  lifecycle_status: string;
  is_online: boolean;
  full_name: string;
  mobile: string;
  vehicle_type: string;
  vehicle_registration_number: string | null;
  pan_number: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  pan_number_encrypted: string | null;
  government_id_number_encrypted: string | null;
  bank_account_number_encrypted: string | null;
  bank_ifsc_encrypted: string | null;
}

async function partner(id: string): Promise<PartnerRow> {
  const [row] = await db()<PartnerRow[]>`
    select status, lifecycle_status, is_online, full_name, mobile, vehicle_type, vehicle_registration_number,
      pan_number, bank_account_number, bank_ifsc, pan_number_encrypted, government_id_number_encrypted,
      bank_account_number_encrypted, bank_ifsc_encrypted
    from delivery_partners where id = ${id}`;
  return need(row, `delivery partner ${id}`);
}

async function partnerOf(userId: string): Promise<{ id: string } | undefined> {
  const [row] = await db()<{ id: string }[]>`select id from delivery_partners where user_id = ${userId} and deleted_at is null`;
  return row;
}

async function titlesFor(userId: string): Promise<string[]> {
  return (await db()<{ title: string }[]>`select title from notifications where user_id = ${userId} order by created_at`).map((r) => r.title);
}

async function auditTrail(partnerId: string) {
  return db()<{ from: string | null; to: string | null; actor: string | null }[]>`
    select previous_value->>'status' as "from", new_value->>'status' as "to", actor_id as actor
    from audit_logs where entity_id = ${partnerId} and action = 'delivery_partner.status_changed' order by created_at`;
}

async function changeRequests(partnerId: string) {
  return db()<{ id: string; status: string; masked: Record<string, string> }[]>`
    select id, status, masked from delivery_partner_change_requests where delivery_partner_id = ${partnerId} order by created_at`;
}

/** Operations decide every pending change request of the rider (cleanup). */
async function rejectPending(partnerId: string) {
  for (const r of await changeRequests(partnerId)) {
    if (r.status === "PENDING") await call(await as("ops"), "POST", `/api/admin/rider-change-requests/${r.id}/decision`, { decision: "reject", reason: "QA cleanup" });
  }
}

async function staff(partnerId: string, body: Record<string, unknown>): Promise<Answer> {
  return call(await as("ops"), "PATCH", `/api/delivery-partner/${partnerId}`, body);
}

async function goOnline(ctx: APIRequestContext): Promise<Answer> {
  const home = homeSpot();
  return call(ctx, "PATCH", "/api/delivery-partner/status", { action: "online", latitude: home.lat + 0.002, longitude: home.lng });
}

/** The world's riders back online near shop A (as seeded), every fresh rider offline. */
async function worldRidersBack() {
  await ridersOnlyOnline({ rider: { dLat: 0.001, dLng: 0.001 }, rider2: { dLat: 0.001, dLng: 0.0015 } });
}

/** A complete application body (the form's fields), for API probes. */
function application(user: FreshUser, extra: Record<string, unknown> = {}) {
  return { fullName: "QA Rider Applicant", mobile: user.mobile, vehicleType: "MOTORCYCLE", vehicleRegistrationNumber: "MH12AB1234", ...extra };
}

/**
 * For an applicant who has already applied, an application that passes every
 * validation is refused only as a duplicate (409); one that fails validation
 * is refused with 422. So each probe shows whether the value is accepted.
 */
async function probe(user: FreshUser, extra: Record<string, unknown>): Promise<"accepted" | "refused" | string> {
  const res = await call(user.ctx, "POST", "/api/delivery-partner", application(user, extra));
  if (res.status === 409) return "accepted";
  if (res.status === 422) return "refused";
  return `HTTP ${res.status}`;
}

/** Text of the whole page (to check that a value is not shown anywhere). */
async function pageText(page: Page) {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

/**
 * A job for a fresh approved rider: every other rider offline, the rider
 * online near shop A, an order placed and packed; the offer reaches the
 * rider. With `to: "DELIVERED"` the rider accepts, picks up with the shop's
 * code, starts and delivers with the customer's code. `onStep` sees each step.
 */
async function freshJob(rider: Rider, to: "OFFERED" | "DELIVERED", onStep: (step: string) => Promise<void> = async () => {}) {
  await ensureWallet();
  await noRiderOnline();
  expectStatus(await goOnline(rider.ctx), 200, "the new rider goes online");
  await onStep("online");
  const placed = await placeSimple();
  await driveTo(placed.id, "READY");
  const find = async () =>
    (await db()<{ id: string; status: string }[]>`
      select id, status from delivery_orders where order_id = ${placed.id} and delivery_partner_id = ${rider.partnerId}
        and status in ('OFFERED','ACCEPTED')`)[0] ?? null;
  let offer = await poll(find, (v) => v !== null, 20_000);
  if (!offer) {
    await cron("/api/cron/delivery-dispatch");
    offer = await poll(find, (v) => v !== null, 10_000);
  }
  const got = need(offer, `the offer for order ${placed.orderNumber} at the new rider`);
  await onStep("offered");
  if (to === "OFFERED") return { placed, deliveryOrderId: got.id };
  const act = (action: string, extra: Record<string, unknown> = {}) => call(rider.ctx, "PATCH", `/api/delivery-orders/${got.id}`, { action, ...extra });
  expectStatus(await act("accept"), 200, "the new rider accepts");
  await onStep("accepted");
  const code = await pickupCode(placed.id);
  expectStatus(await act("pickup", code ? { pickupCode: code } : {}), 200, "pickup");
  await onStep("picked up");
  expectStatus(await act("start"), 200, "start the drop");
  await onStep("started");
  expectStatus(await act("deliver", { otp: await buyerCode(placed.id) }), 200, "deliver");
  await onStep("delivered");
  return { placed, deliveryOrderId: got.id };
}

/** An approved fresh rider with one delivered job in the history (kept for the gig-portal check). */
async function riderWithHistory(): Promise<{ rider: Rider; orderNumber: string }> {
  const saved = kept<{ rider: Omit<Rider, "ctx">; orderNumber: string }>("riders:with-history");
  if (saved && (await partner(saved.rider.partnerId)).status === "APPROVED") return { rider: await freshAgain(saved.rider), orderNumber: saved.orderNumber };
  const rider = await freshRider("history", { approve: true });
  try {
    const job = await freshJob(rider, "DELIVERED");
    const { ctx: _ctx, ...plain } = rider;
    void _ctx;
    keep("riders:with-history", { rider: plain, orderNumber: job.placed.orderNumber });
    return { rider, orderNumber: job.placed.orderNumber };
  } finally {
    await worldRidersBack();
  }
}

/* ------------------------------------------------ application (DEL-014) */

qa("TC-DEL-014", "rider application: the form flags missing required fields and sends nothing; a complete application (profile, vehicle, KYC, bank) is created for review with KYC stored encrypted", async ({ browser }) => {
  const user = await freshCustomer("del014");
  const { context, page } = await freshPage(browser, user);
  try {
    await page.goto("/delivery-partner/apply");
    await page.getByRole("link", { name: /Start my application/ }).click();
    await expect(page).toHaveURL(/\/delivery-partner\/register/);

    // 3. Missing required fields: the browser flags them and nothing is sent.
    await page.getByRole("button", { name: "Submit application" }).click();
    const flagged = await page.evaluate(() => Array.from(document.querySelectorAll("form :invalid")).map((el) => (el as HTMLInputElement).name).filter(Boolean));
    expect(flagged, "fields flagged on an empty submit").toEqual(expect.arrayContaining(["fullName", "mobile", "vehicleType"]));
    await expect(page).toHaveURL(/\/delivery-partner\/register/);
    expect(await partnerOf(user.id), "no application after the empty submit").toBeUndefined();
    // The server flags them too (a request without the form's checks).
    const missing = await call(user.ctx, "POST", "/api/delivery-partner", { mobile: "", vehicleType: "" });
    expectStatus(missing, 422, "application with the required fields missing");
    const fields = Object.keys(missing.body?.error?.details?.fields ?? {});
    expect(fields, "fields the server names").toEqual(expect.arrayContaining(["fullName", "mobile", "vehicleType"]));

    // 2. A complete application.
    await page.getByLabel("Full name").fill(`QA Applicant ${user.mobile}`);
    await page.getByLabel("Mobile number").fill(user.mobile);
    await page.getByLabel("PAN (optional)").fill("ABCDE1234F");
    await page.getByLabel("Government ID type (optional)").fill("Aadhaar");
    await page.getByLabel("Government ID number (optional)").fill("234123412346");
    await page.getByLabel("Bank account holder name (optional)").fill("QA Applicant");
    await page.getByLabel("Bank account number (optional)").fill("123456789012");
    await page.getByLabel("Bank IFSC (optional)").fill("SBIN0001234");
    await page.getByLabel("Vehicle type").selectOption({ label: "Motorcycle" });
    await page.getByLabel("Vehicle registration number (optional)").fill("MH12AB1234");
    await page.getByRole("button", { name: "Submit application" }).click();
    await expect(page).toHaveURL(/\/delivery-partner$/, { timeout: 30_000 });
    await expect(page.getByText("Your application has been received and is waiting to be reviewed.")).toBeVisible();

    const created = need(await partnerOf(user.id), "the new application");
    const row = await partner(created.id);
    expect(row.status, "application status").toBe("REGISTERED");
    expect([row.pan_number, row.bank_account_number, row.bank_ifsc], "no plain KYC columns").toEqual([null, null, null]);
    for (const [name, cipher, plain] of [
      ["PAN", row.pan_number_encrypted, "ABCDE1234F"],
      ["ID number", row.government_id_number_encrypted, "234123412346"],
      ["bank account", row.bank_account_number_encrypted, "123456789012"],
      ["IFSC", row.bank_ifsc_encrypted, "SBIN0001234"],
    ] as const) {
      expect(cipher, `${name} stored encrypted`).toBeTruthy();
      expect(cipher, `${name} ciphertext`).not.toContain(plain);
    }
    const [audit] = await db()<{ n: number }[]>`select count(*)::int as n from audit_logs where entity_id = ${created.id} and action = 'delivery_partner.registered'`;
    expect(audit.n, "registration audit entry").toBe(1);
    return `empty submit flagged ${flagged.join(", ")} (nothing created; API 422 names ${fields.join(", ")}); complete application → REGISTERED, "waiting to be reviewed", KYC/bank in *_encrypted columns only`;
  } finally {
    await context.close();
    await user.ctx.dispose();
  }
}, local);

/* ------------------------------------------- operations review (DEL-015) */

qa("TC-DEL-015", "operator console: start review → approve; reject another with a reason; suspend, reactivate and deactivate the approved one — each audited, and only APPROVED riders can go online", async ({ browser }) => {
  const a = await freshRider("del015a");
  const b = await freshRider("del015b");
  const { context, page } = await pageAs(browser, "ops");
  const online: Record<string, number> = {};
  const tryOnline = async (label: string) => {
    online[label] = (await goOnline(a.ctx)).status;
    if (online[label] === 200) await call(a.ctx, "PATCH", "/api/delivery-partner/status", { action: "offline" });
  };
  const statusIs = async (id: string, status: string) =>
    expect.poll(async () => (await partner(id)).status, { message: `rider status ${status}`, timeout: 15_000 }).toBe(status);
  const open = async (mobile: string) => {
    await page.goto("/admin/console/riders");
    await page.getByPlaceholder("Name or mobile").fill(mobile);
    await expect(page.getByText(mobile).first()).toBeVisible();
  };
  try {
    await tryOnline("REGISTERED");
    await open(a.mobile);
    await page.getByRole("button", { name: "Start review" }).click();
    await statusIs(a.partnerId, "UNDER_REVIEW");
    await tryOnline("UNDER_REVIEW");
    await page.getByRole("button", { name: "Approve" }).click();
    await statusIs(a.partnerId, "APPROVED");
    await tryOnline("APPROVED");

    await page.getByRole("button", { name: "Suspend" }).click();
    await page.getByPlaceholder("Reason for suspend").fill("QA: documents expired");
    await page.getByRole("button", { name: "Confirm" }).click();
    await statusIs(a.partnerId, "SUSPENDED");
    await expect(page.getByText("Reason on file: QA: documents expired")).toBeVisible();
    await tryOnline("SUSPENDED");
    await page.getByRole("button", { name: "Reactivate" }).click();
    // TC-DEL-027: reactivating asks for a reason, like suspending.
    await page.getByPlaceholder("Reason for reactivate").fill("QA: documents renewed");
    await page.getByRole("button", { name: "Confirm" }).click();
    await statusIs(a.partnerId, "APPROVED");
    await tryOnline("APPROVED again");
    await page.getByRole("button", { name: "Deactivate" }).click();
    await page.getByPlaceholder("Reason for deactivate").fill("QA: left the platform");
    await page.getByRole("button", { name: "Confirm" }).click();
    await statusIs(a.partnerId, "DEACTIVATED");
    await tryOnline("DEACTIVATED");

    await open(b.mobile);
    await page.getByRole("button", { name: "Reject" }).click();
    const confirm = page.getByRole("button", { name: "Confirm" });
    await page.getByPlaceholder("Reason for reject").fill("QA");
    await expect(confirm, "Confirm waits for a reason of 3+ characters").toBeDisabled();
    await page.getByPlaceholder("Reason for reject").fill("QA: vehicle papers unclear");
    await confirm.click();
    await statusIs(b.partnerId, "REJECTED");
    await expect(page.getByText("Reason on file: QA: vehicle papers unclear")).toBeVisible();
    const noReason = await staff(b.partnerId, { action: "reject" });

    const trailA = (await auditTrail(a.partnerId)).map((r) => `${r.from}→${r.to}`);
    const trailB = (await auditTrail(b.partnerId)).map((r) => `${r.from}→${r.to}`);
    const opsId = need((await auditTrail(a.partnerId))[0]?.actor, "audit actor");
    expect(trailA, "audit of rider A").toEqual([
      "REGISTERED→UNDER_REVIEW",
      "UNDER_REVIEW→APPROVED",
      "APPROVED→SUSPENDED",
      "SUSPENDED→APPROVED",
      "APPROVED→DEACTIVATED",
    ]);
    expect(trailB, "audit of rider B").toEqual(["REGISTERED→REJECTED"]);
    expect(opsId, "audited actor is the operator").not.toBe(a.id);
    expect(noReason.status, "reject without a reason").toBe(422);
    const verdict = Object.fromEntries(Object.entries(online).map(([k, v]) => [k, v === 200 ? "online" : "refused"]));
    expect(verdict, `go-online per status ${JSON.stringify(online)}`).toEqual({
      REGISTERED: "refused",
      UNDER_REVIEW: "refused",
      APPROVED: "online",
      SUSPENDED: "refused",
      "APPROVED again": "online",
      DEACTIVATED: "refused",
    });
    return `A: ${trailA.join(", ")}; B: ${trailB.join(", ")} (reason required); go online: ${JSON.stringify(online)}`;
  } finally {
    await context.close();
    await call(a.ctx, "PATCH", "/api/delivery-partner/status", { action: "offline" });
    await a.ctx.dispose();
    await b.ctx.dispose();
  }
}, { ...local, partial: "the rider notices are checked in the next check" });

qa("TC-DEL-015", "the rider is notified of each review decision (approve, reject, suspend, reactivate, deactivate)", async () => {
  const a = await freshRider("del015n");
  const b = await freshRider("del015m");
  try {
    const steps: [Rider, string, Record<string, unknown>][] = [
      [a, "approve", { action: "approve" }],
      [a, "suspend", { action: "suspend", reason: "QA: suspended for the notice check" }],
      [a, "reactivate", { action: "reactivate", reason: "QA: reactivated for the notice check" }],
      [a, "deactivate", { action: "deactivate", reason: "QA: deactivated for the notice check" }],
      [b, "reject", { action: "reject", reason: "QA: rejected for the notice check" }],
    ];
    const got: Record<string, string> = {};
    for (const [rider, name, body] of steps) {
      const before = (await titlesFor(rider.id)).length;
      expectStatus(await staff(rider.partnerId, body), 200, name);
      const after = await poll(async () => titlesFor(rider.id), (t) => t.length > before, 5_000);
      got[name] = (after ?? (await titlesFor(rider.id))).slice(before).join(" | ") || "(no notice)";
    }
    const silent = Object.entries(got).filter(([, t]) => t === "(no notice)").map(([n]) => n);
    expect(silent, `decisions without a notice to the rider (${JSON.stringify(got)})`).toEqual([]);
    return JSON.stringify(got);
  } finally {
    await a.ctx.dispose();
    await b.ctx.dispose();
  }
}, local);

/* ------------------------------------------ KYC not displayed (DEL-016) */

qa("TC-DEL-016", "/gig/profile shows vehicle type and registration; identity and bank details are not displayed (nor returned by the profile API)", async ({ browser }) => {
  // A well-formed Aadhaar number (check digit valid): the application checks it since TC-FLD-092.
  const secrets = { panNumber: "QWERT6789Z", governmentIdType: "Aadhaar", governmentIdNumber: "234123412346", bankAccountHolderName: "QA Holder", bankAccountNumber: "998877665544", bankIfsc: "SBIN0004321" };
  const rider = await freshRider("del016", { approve: true, extra: { ...secrets, drivingLicenceNumber: "MH1220110012345" } });
  const { context, page } = await freshPage(browser, rider);
  try {
    await page.goto("/gig/profile");
    const vehicle = page.locator("section", { has: page.getByRole("heading", { name: "Vehicle & operating area" }) });
    await expect(vehicle.locator("dd").filter({ hasText: /^Motorcycle$/ })).toBeVisible();
    await expect(vehicle.locator("dd").filter({ hasText: "MH12AB1234" })).toBeVisible();
    await expect(page.getByText("Identity and bank details are stored encrypted and are not shown here.")).toBeVisible();
    const text = await pageText(page);
    const html = await page.content();
    const shown = [...Object.entries(secrets).filter(([k]) => k !== "governmentIdType" && k !== "bankAccountHolderName"), ["drivingLicenceNumber", "MH1220110012345"]]
      .filter(([, v]) => text.includes(v) || html.includes(v))
      .map(([k]) => k);
    expect(shown, "identity / bank values on the page").toEqual([]);
    const me = await call(rider.ctx, "GET", "/api/delivery-partner/me");
    expectStatus(me, 200, "own profile");
    const leaked = Object.keys(me.body ?? {}).filter((k) => /pan|governmentIdNumber|bank|drivingLicence/i.test(k));
    expect(leaked, "KYC keys in GET /api/delivery-partner/me").toEqual([]);
    return "vehicle Motorcycle · MH12AB1234 shown; PAN, ID, bank account, IFSC and licence neither on the page nor in the profile API";
  } finally {
    await context.close();
    await rider.ctx.dispose();
  }
}, { ...local, partial: "\"Profile is read-only\" is superseded by F2 (docs/marketplace-features-2026-10/README.md, src/server/services/rider-profile.ts): everyday details are editable, identity/bank changes go to admin review — see TC-DEL-028/029" });

/* -------------------------------------------- gig portal pages (DEL-017) */

qa("TC-DEL-017", "gig portal: unregistered → apply call-to-action; not approved → no action links; approved → My Deliveries with the active job, and the history without the active row", async ({ browser }) => {
  const outsider = await freshCustomer("del017u");
  const applicant = await freshRider("del017r");
  const found: string[] = [];
  let activeOrder: string | undefined;
  try {
    // Unregistered.
    {
      const { context, page } = await freshPage(browser, outsider);
      for (const path of ["/gig/orders", "/gig/profile"]) {
        await page.goto(path);
        await expect(page.getByText("You're not a delivery partner yet")).toBeVisible();
        await expect(page.getByRole("main").locator('a[href="/delivery-partner/apply"]').filter({ hasText: "Become a delivery partner" }).first()).toBeVisible();
      }
      found.push("unregistered: apply link on both pages");
      await context.close();
    }
    // Registered, not approved.
    {
      const { context, page } = await freshPage(browser, applicant);
      await page.goto("/gig/orders");
      await expect(page.getByText("Not receiving offers")).toBeVisible();
      await expect(page.getByText("No active delivery.")).toBeVisible();
      for (const name of ["Go online", "Accept or reject", "Continue delivery"]) await expect(page.getByRole("link", { name })).toHaveCount(0);
      await page.goto("/gig/profile");
      await expect(page.getByText("Only approved partners receive delivery offers.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Show my ID card" })).toHaveCount(0);
      found.push("not approved: 'Not receiving offers', no go-online / offer / ID-card links");
      await context.close();
    }
    // Approved, with a delivered job in the history and a new offer in hand.
    const { rider, orderNumber } = await riderWithHistory();
    const { context, page } = await freshPage(browser, rider);
    try {
      await call(rider.ctx, "PATCH", "/api/delivery-partner/status", { action: "offline" });
      await page.goto("/gig/orders");
      await expect(page.getByRole("heading", { name: "My Deliveries" })).toBeVisible();
      await expect(page.getByText("You're offline. Go online from the rider dashboard to receive delivery offers.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Go online" })).toBeVisible();
      found.push("approved, no job: offline note with a Go online link");

      const job = await freshJob(rider, "OFFERED");
      activeOrder = job.placed.id;
      await page.goto("/gig/orders");
      const current = page.locator("section", { has: page.getByRole("heading", { name: "Current delivery" }) });
      const history = page.locator("section", { has: page.getByRole("heading", { name: "Delivery history" }) });
      await expect(current.getByText(job.placed.orderNumber)).toBeVisible();
      await expect(current.getByText("New offer waiting for your answer")).toBeVisible();
      await expect(current.getByRole("link", { name: "Accept or reject" })).toBeVisible();
      await expect(history.getByText(orderNumber)).toBeVisible();
      await expect(history.getByText(job.placed.orderNumber), "the active job is not in the history").toHaveCount(0);
      found.push(`approved with a job: current ${job.placed.orderNumber} (offer), history ${orderNumber} without the active row`);
    } finally {
      await context.close();
      await rider.ctx.dispose();
    }
    return found.join("; ");
  } finally {
    await abandon(activeOrder);
    await worldRidersBack();
    await outsider.ctx.dispose();
    await applicant.ctx.dispose();
  }
}, local);

/* --------------------------------------- partner lifecycle (DEL-025) */

qa("TC-DEL-025", "partner lifecycle: onboarding (KYC pending) until approved, then offline/available, busy with an offer, on delivery after pickup, available again after the drop — each change logged", async () => {
  const rider = await freshRider("del025");
  const seen: string[] = [];
  const look = async (step: string) => {
    const row = await partner(rider.partnerId);
    seen.push(`${step}: ${row.lifecycle_status}`);
  };
  try {
    await look("applied, no documents");
    expectStatus(await upload(rider.ctx, "/api/delivery-partner/me/documents", { name: "aadhaar.png", mimeType: "image/png", buffer: png(400, 260) }, { docType: "AADHAAR" }), 201, "upload a KYC document");
    await look("document uploaded");
    expectStatus(await staff(rider.partnerId, { action: "start_review" }), 200, "start review");
    await look("under review");
    expectStatus(await staff(rider.partnerId, { action: "approve" }), 200, "approve");
    await look("approved");
    await freshJob({ ...rider }, "DELIVERED", look);
    const states = seen.map((s) => s.split(": ")[1]);
    expect(states, seen.join(" · ")).toEqual(["ONBOARDING", "ONBOARDING", "ONBOARDING", "OFFLINE", "AVAILABLE", "BUSY", "BUSY", "ON_DELIVERY", "ON_DELIVERY", "AVAILABLE"]);
    const logged = await db()<{ to: string }[]>`select to_status as "to" from status_changes where entity_type = 'RIDER' and entity_id = ${rider.partnerId} order by created_at`;
    expect(logged.map((r) => r.to), "status_changes log").toEqual(["ONBOARDING", "OFFLINE", "AVAILABLE", "BUSY", "ON_DELIVERY", "AVAILABLE"]);
    const { ctx: _ctx, ...plain } = rider;
    void _ctx;
    keep("riders:with-history", { rider: plain, orderNumber: (await db()<{ n: string }[]>`select o.order_number as n from orders o join delivery_orders d on d.order_id = o.id where d.delivery_partner_id = ${rider.partnerId} and d.status = 'DELIVERED' limit 1`)[0]?.n });
    return seen.join(" · ");
  } finally {
    await call(rider.ctx, "PATCH", "/api/delivery-partner/status", { action: "offline" });
    await worldRidersBack();
    await rider.ctx.dispose();
  }
}, { ...local, partial: "the app's names (src/lib/status-models.ts, F1): ONBOARDING = KYC_PENDING, ON_DELIVERY = DELIVERING, BUSY = holding an offer or accepted job; transitions driven through the console's API, states read from the database; the documents gate is the next check" });

qa("TC-DEL-025", "a rider stays KYC pending (onboarding) until the identity documents are in: approval without any document is refused", async () => {
  const rider = await freshRider("del025k");
  try {
    const [docs] = await db()<{ n: number }[]>`select count(*)::int as n from delivery_partner_documents where delivery_partner_id = ${rider.partnerId}`;
    expect(docs.n, "documents on file").toBe(0);
    const res = await staff(rider.partnerId, { action: "approve" });
    const row = await partner(rider.partnerId);
    expect(`${res.status} ${row.status}/${row.lifecycle_status}`, "approving a rider with no identity document").not.toBe("200 APPROVED/OFFLINE");
    return `approve with no documents → ${res.status}, rider ${row.status}/${row.lifecycle_status}`;
  } finally {
    await rider.ctx.dispose();
  }
}, local);

/* ------------------------------------- illegal transitions (DEL-027) */

qa("TC-DEL-027", "illegal partner transitions: a rejected rider cannot be put to work (online / reactivate / suspend), a deactivated one cannot come back, and a blocked (suspended) rider does not return to APPROVED without a reason", async () => {
  const rejected = await freshRider("del027r");
  const blockedRider = await freshRider("del027s", { approve: true });
  const closed = await freshRider("del027d");
  const seen: Record<string, string> = {};
  const problems: string[] = [];
  try {
    expectStatus(await staff(rejected.partnerId, { action: "reject", reason: "QA: rejected" }), 200, "reject");
    seen["REJECTED: go online"] = String((await goOnline(rejected.ctx)).status);
    // With a reason, so the answer is about the status (a reason is required since TC-DEL-027).
    seen["REJECTED: reactivate"] = String((await staff(rejected.partnerId, { action: "reactivate", reason: "QA: put a rejected rider to work" })).status);
    seen["REJECTED: suspend"] = String((await staff(rejected.partnerId, { action: "suspend", reason: "QA: suspend a rejected rider" })).status);
    const r = await partner(rejected.partnerId);
    seen["REJECTED: state after"] = `${r.status}/${r.lifecycle_status}`;
    for (const k of ["REJECTED: go online", "REJECTED: reactivate", "REJECTED: suspend"]) if (seen[k] !== "409") problems.push(`${k} → ${seen[k]}`);
    if (r.status !== "REJECTED" || r.lifecycle_status !== "REJECTED") problems.push(`rejected rider moved to ${seen["REJECTED: state after"]}`);

    expectStatus(await staff(closed.partnerId, { action: "deactivate", reason: "QA: closed" }), 200, "deactivate");
    seen["DEACTIVATED: approve"] = String((await staff(closed.partnerId, { action: "approve" })).status);
    seen["DEACTIVATED: reactivate"] = String((await staff(closed.partnerId, { action: "reactivate" })).status);
    if ((await partner(closed.partnerId)).status !== "DEACTIVATED") problems.push("a deactivated rider came back");

    expectStatus(await staff(blockedRider.partnerId, { action: "suspend", reason: "QA: blocked" }), 200, "suspend");
    const back = await staff(blockedRider.partnerId, { action: "reactivate" });
    seen["SUSPENDED: reactivate with no reason"] = `${back.status} → ${(await partner(blockedRider.partnerId)).status}`;
    if (back.status === 200) problems.push(`SUSPENDED → APPROVED with no reason (reactivate ${back.status})`);
    // Refused above, the rider is still suspended; suspend again only if the reactivate went through.
    if ((await partner(blockedRider.partnerId)).status !== "SUSPENDED") {
      expectStatus(await staff(blockedRider.partnerId, { action: "suspend", reason: "QA: blocked again" }), 200, "suspend again");
    }
    const approve = await staff(blockedRider.partnerId, { action: "approve" });
    seen["SUSPENDED: approve with no reason"] = `${approve.status} → ${(await partner(blockedRider.partnerId)).status}`;
    if (approve.status === 200) problems.push(`SUSPENDED → APPROVED through "approve" (no reason, no reactivate guard) ${approve.status}`);
    const rejectedAgain = await staff(rejected.partnerId, { action: "approve" });
    seen["REJECTED: approve"] = `${rejectedAgain.status} → ${(await partner(rejected.partnerId)).status}`;

    expect(problems, JSON.stringify(seen)).toEqual([]);
    return JSON.stringify(seen);
  } finally {
    for (const r of [rejected, blockedRider, closed]) await r.ctx.dispose();
  }
}, { ...local, partial: "REJECTED → DELIVERING is not reachable through any API (an assignment needs an APPROVED, online rider; the database lifecycle trigger has no REJECTED → ON_DELIVERY rule), so the check shows that a rejected rider cannot go online or be reactivated; BLOCKED is read as SUSPENDED" });

/* ---------------------------------------- vehicle self-edit (DEL-028) */

qa("TC-DEL-028", "rider changes vehicle type and registration on /gig/profile: saved and shown (registration normalised to upper case); recorded: no re-verification before the next job", async ({ browser }) => {
  const rider = await freshRider("del028", { approve: true });
  const { context, page } = await freshPage(browser, rider);
  try {
    await page.goto("/gig/profile");
    const editor = page.getByTestId("rider-profile-editor");
    await editor.getByLabel("Vehicle").selectOption("SCOOTER");
    await editor.getByLabel("Registration number").fill("  mh14 cd   5678 ");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor.getByText("Saved.")).toBeVisible();
    const vehicle = page.locator("section", { has: page.getByRole("heading", { name: "Vehicle & operating area" }) });
    await expect(vehicle.locator("dd").filter({ hasText: /^Scooter$/ })).toBeVisible();
    await expect(vehicle.locator("dd").filter({ hasText: "MH14 CD 5678" })).toBeVisible();
    const row = await partner(rider.partnerId);
    expect([row.vehicle_type, row.vehicle_registration_number, row.status], "stored").toEqual(["SCOOTER", "MH14 CD 5678", "APPROVED"]);
    const online = await goOnline(rider.ctx);
    await call(rider.ctx, "PATCH", "/api/delivery-partner/status", { action: "offline" });
    const [audit] = await db()<{ fields: string }[]>`select new_value->>'fields' as fields from audit_logs where entity_id = ${rider.partnerId} and action = 'delivery_partner.profile_updated' order by created_at desc limit 1`;
    expect(audit?.fields, "profile change audited").toContain("vehicleType");
    return `saved: SCOOTER · "MH14 CD 5678" (typed "  mh14 cd   5678 "); the rider stays APPROVED and can go online at once (${online.status}) — no re-verification; audited fields ${audit?.fields}`;
  } finally {
    await context.close();
    await rider.ctx.dispose();
  }
}, local);

/* ------------------------------------------ bank self-edit (DEL-029) */

qa("TC-DEL-029", "rider changes bank account and IFSC: held masked for review, applied (encrypted) only when operations approve, and the rider is notified", async ({ browser }) => {
  const rider = await freshRider("del029", { approve: true });
  const { context, page } = await freshPage(browser, rider);
  const ops = await pageAs(browser, "ops");
  try {
    const before = await partner(rider.partnerId);
    await page.goto("/gig/profile");
    const card = page.getByTestId("rider-sensitive-request");
    await card.getByLabel("Bank account number").fill("123456789012");
    await card.getByLabel("IFSC").fill("hdfc0001234");
    await card.getByRole("button", { name: "Send for review" }).click();
    await expect(card.getByText("Sent for review. You'll be notified when it's approved.")).toBeVisible();
    const waiting = card.getByText(/Waiting for review:/);
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText("Bank account number …9012");
    await expect(waiting).toContainText("IFSC …1234");
    expect((await pageText(page)).includes("123456789012"), "full account number on the page").toBe(false);
    const held = await partner(rider.partnerId);
    expect([held.bank_account_number_encrypted, held.bank_ifsc_encrypted], "not applied before review").toEqual([before.bank_account_number_encrypted, before.bank_ifsc_encrypted]);

    await ops.page.goto("/admin/rider-changes");
    const request = ops.page.getByTestId("rider-change-request").filter({ hasText: rider.mobile });
    await expect(request.getByText("…9012")).toBeVisible();
    expect((await request.innerText()).includes("123456789012"), "full number shown to the reviewer").toBe(false);
    await request.getByRole("button", { name: "Approve" }).click();
    await expect(request).toHaveCount(0);

    const applied = await partner(rider.partnerId);
    expect(applied.bank_account_number_encrypted, "account applied, encrypted").toBeTruthy();
    expect(applied.bank_account_number_encrypted).not.toBe(before.bank_account_number_encrypted);
    expect(applied.bank_account_number_encrypted).not.toContain("123456789012");
    expect(applied.bank_ifsc_encrypted, "IFSC applied, encrypted").toBeTruthy();
    expect(applied.bank_account_number, "no plain column").toBeNull();
    const notes = await titlesFor(rider.id);
    expect(notes, "rider notified").toContain("Your profile change was approved");
    await page.goto("/gig/profile");
    await expect(page.getByText("Last request: approved")).toBeVisible();
    return "held for review as Bank account number …9012, IFSC …1234 (stored values unchanged); operator approved on /admin/rider-changes → encrypted columns replaced; notice 'Your profile change was approved'";
  } finally {
    await rejectPending(rider.partnerId);
    await ops.context.close();
    await context.close();
    await rider.ctx.dispose();
  }
}, { ...local, partial: "the confirmation code is superseded by F2 (src/server/services/rider-profile.ts, docs/marketplace-features-2026-10/README.md): bank changes wait for an operator's approval instead; payouts are not made to rider bank accounts in the app, so 'payouts go to the new account' cannot be shown" });

/* ---------------------------------------- invalid profile edits (DEL-030) */

qa("TC-DEL-030", "invalid profile edits (bad IFSC, account number with letters, vehicle number with symbols) are refused with a message and the stored details stay unchanged", async ({ browser }) => {
  const rider = await freshRider("del030", { approve: true });
  const { context, page } = await freshPage(browser, rider);
  const seen: string[] = [];
  const problems: string[] = [];
  try {
    const before = await partner(rider.partnerId);
    await page.goto("/gig/profile");
    const card = page.getByTestId("rider-sensitive-request");
    await card.getByLabel("IFSC").fill("SBIN12");
    await card.getByRole("button", { name: "Send for review" }).click();
    await expect(card.getByText("IFSC must be 11 characters, e.g. SBIN0001234.")).toBeVisible();
    if ((await changeRequests(rider.partnerId)).length !== 0) problems.push("a request was stored for the bad IFSC");
    seen.push("IFSC SBIN12 refused: 'IFSC must be 11 characters, e.g. SBIN0001234.'");

    const letters = await call(rider.ctx, "POST", "/api/delivery-partner/me/change-request", { bankAccountNumber: "12AB34CD56" });
    seen.push(`account 12AB34CD56 → ${letters.status}`);
    if (letters.status !== 422) problems.push(`account number with letters accepted (${letters.status}, held for review as ${JSON.stringify(letters.body?.masked)})`);

    const editor = page.getByTestId("rider-profile-editor");
    await editor.getByLabel("Registration number").fill("MH12@#$%^&*");
    await editor.getByRole("button", { name: "Save" }).click();
    // "Saved." or the refusal under the form (the editor's Alert carries no alert role).
    const outcome = editor.getByText(/^Saved\.$|registration number as on the RC|check the highlighted fields/i);
    await expect(outcome.first()).toBeVisible();
    seen.push(`the form says "${(await outcome.first().innerText()).trim()}"`);
    const reg = (await partner(rider.partnerId)).vehicle_registration_number;
    seen.push(`vehicle MH12@#$%^&* → stored ${JSON.stringify(reg)}`);
    if (reg !== before.vehicle_registration_number) problems.push(`vehicle number with symbols saved as ${JSON.stringify(reg)}`);

    const after = await partner(rider.partnerId);
    if (after.bank_ifsc_encrypted !== before.bank_ifsc_encrypted || after.bank_account_number_encrypted !== before.bank_account_number_encrypted) problems.push("bank details changed");
    expect(problems, seen.join("; ")).toEqual([]);
    return seen.join("; ");
  } finally {
    await rejectPending(rider.partnerId);
    await call(rider.ctx, "PATCH", "/api/delivery-partner/me", { vehicleRegistrationNumber: "MH12AB1234" });
    await context.close();
    await rider.ctx.dispose();
  }
}, { ...local, partial: "step 2 (a wrong confirmation code) does not apply: there is no code — identity/bank changes wait for operator approval (F2, src/server/services/rider-profile.ts); the IFSC refusal is a message under the form, not on the field" });

/* ---------------------------------- other rider / self-approve (DEL-031) */

qa("TC-DEL-031", "a rider cannot act on another rider's profile (403) nor approve itself: status / KYC flags in the own profile update are refused, and a KYC change waits for review", async () => {
  const applicant = await freshRider("del031a");
  const other = await freshRider("del031b", { approve: true });
  const seen: Record<string, number | string> = {};
  try {
    seen["PATCH other rider (approve)"] = (await call(applicant.ctx, "PATCH", `/api/delivery-partner/${other.partnerId}`, { action: "approve" })).status;
    seen["PATCH other rider (suspend)"] = (await call(applicant.ctx, "PATCH", `/api/delivery-partner/${other.partnerId}`, { action: "suspend", reason: "QA: rider suspends rider" })).status;
    seen["GET other rider"] = (await call(applicant.ctx, "GET", `/api/delivery-partner/${other.partnerId}`)).status;
    for (const [name, body] of [
      ["status=APPROVED", { status: "APPROVED" }],
      ["kyc=VERIFIED", { kyc: "VERIFIED" }],
      ["vehicle + status=APPROVED", { vehicleType: "SCOOTER", status: "APPROVED" }],
      ["isOnline=true", { isOnline: true }],
    ] as const) {
      seen[`own PATCH ${name}`] = (await call(applicant.ctx, "PATCH", "/api/delivery-partner/me", body)).status;
    }
    const row = await partner(applicant.partnerId);
    seen["own status after"] = `${row.status}/${row.vehicle_type}`;
    const kyc = await call(other.ctx, "POST", "/api/delivery-partner/me/change-request", { panNumber: "ABCDE1234F" });
    seen["approved rider's KYC change"] = `${kyc.status} ${kyc.body?.status} (rider ${(await partner(other.partnerId)).status})`;
    expect(seen, "answers").toEqual({
      "PATCH other rider (approve)": 403,
      "PATCH other rider (suspend)": 403,
      "GET other rider": 403,
      "own PATCH status=APPROVED": 422,
      "own PATCH kyc=VERIFIED": 422,
      "own PATCH vehicle + status=APPROVED": 422,
      "own PATCH isOnline=true": 422,
      "own status after": "REGISTERED/MOTORCYCLE",
      "approved rider's KYC change": "201 PENDING (rider APPROVED)",
    });
    expect((await partner(other.partnerId)).status, "the other rider untouched").toBe("APPROVED");
    return JSON.stringify(seen);
  } finally {
    await rejectPending(other.partnerId);
    await applicant.ctx.dispose();
    await other.ctx.dispose();
  }
}, { ...local, partial: "status fields are refused with 422 (strict body) rather than ignored — nothing is changed either way; a KYC change is held for admin review (F2) instead of returning the rider to review" });

/* --------------------------------------- field cases (FLD-090..093) */

qa("TC-FLD-090", "rider application name and mobile: blank / spaces / 1 character refused with a field message, limit 120, script stored as text, Marathi saved, outer spaces trimmed, mobile follows the Indian 10-digit rule", async ({ browser }) => {
  const formUser = await freshCustomer("fld090f");
  const apiUser = await freshCustomer("fld090a");
  const { context, page } = await freshPage(browser, formUser);
  const seen: string[] = [];
  let dialogs = 0;
  try {
    // Form: blank is flagged by the browser; spaces-only and one character by the server, on the field.
    await page.goto("/delivery-partner/register");
    await page.getByLabel("Mobile number").fill(formUser.mobile);
    await page.getByLabel("Vehicle type").selectOption({ label: "Bicycle" });
    await page.getByRole("button", { name: "Submit application" }).click();
    expect(await page.getByLabel("Full name").evaluate((el) => (el as HTMLInputElement).validity.valueMissing), "blank name flagged").toBe(true);
    for (const value of ["     ", "A"]) {
      await page.getByLabel("Full name").fill(value);
      await page.getByRole("button", { name: "Submit application" }).click();
      await expect(page.getByText("Please check the highlighted fields.")).toBeVisible();
      const label = page.locator("label", { has: page.locator('input[name="fullName"]') });
      await expect(label, `field message under Full name for ${JSON.stringify(value)}`).not.toHaveText(/^\s*Full name\s*$/);
      seen.push(`${JSON.stringify(value)} → "${(await label.innerText()).replace("Full name", "").trim()}"`);
    }
    for (const bad of ["5876543210", "98765 43210"]) {
      await page.getByLabel("Mobile number").fill(bad);
      await page.getByLabel("Full name").fill("QA Form Rider");
      await page.getByRole("button", { name: "Submit application" }).click();
      expect(await page.getByLabel("Mobile number").evaluate((el) => !(el as HTMLInputElement).validity.valid), `mobile ${bad} flagged`).toBe(true);
    }
    expect(await partnerOf(formUser.id), "nothing created from the form").toBeUndefined();

    // API: the stored value.
    page.on("dialog", (d) => {
      dialogs += 1;
      void d.dismiss();
    });
    const name = `  ${TEXT.marathi} ${TEXT.script}  `;
    const created = await call(apiUser.ctx, "POST", "/api/delivery-partner", application(apiUser, { fullName: name }));
    expectStatus(created, 201, "application with a Marathi + script name");
    const stored = (await partner(String(created.body.id))).full_name;
    expect(stored, "stored name (trimmed, as typed)").toBe(name.trim());
    const view = await freshPage(browser, apiUser);
    await view.page.goto("/gig/profile");
    await expect(view.page.locator("dd").filter({ hasText: TEXT.marathi }).first()).toBeVisible();
    expect(await view.page.locator("script").filter({ hasText: "alert(1)" }).count(), "no script element from the name").toBe(0);
    await view.context.close();

    // API probes (409 = passes every check and is refused only as a second application).
    const probes: Record<string, string> = {};
    for (const [label, fullName] of [
      ["blank", ""],
      ["spaces", "     "],
      ["1 char", "A"],
      ["120 chars", TEXT.long(120)],
      ["121 chars", TEXT.long(121)],
      ["300 chars", TEXT.long(300)],
      ["Hindi", TEXT.hindi],
    ] as const) probes[`name ${label}`] = await probe(apiUser, { fullName });
    for (const [label, mobile] of [
      ["blank", ""],
      ["9 digits", "987654321"],
      ["11 digits", "98765432101"],
      ["first digit 5", "5876543210"],
      ["letters", "98765abcde"],
      ["symbols", "98765-4321"],
      ["spaces", "98765 43210"],
      ["+91", "+919876543210"],
      ["+91 again", "+919876543210"],
      ["valid", "9876543210"],
    ] as const) probes[`mobile ${label}`] = await probe(apiUser, { mobile });
    expect(probes, "accepted / refused").toEqual({
      "name blank": "refused",
      "name spaces": "refused",
      "name 1 char": "refused",
      "name 120 chars": "accepted",
      "name 121 chars": "refused",
      "name 300 chars": "refused",
      "name Hindi": "accepted",
      "mobile blank": "refused",
      "mobile 9 digits": "refused",
      "mobile 11 digits": "refused",
      "mobile first digit 5": "refused",
      "mobile letters": "refused",
      "mobile symbols": "refused",
      "mobile spaces": "refused",
      "mobile +91": "refused",
      "mobile +91 again": "refused",
      "mobile valid": "accepted",
    });
    expect(dialogs, "script never ran").toBe(0);
    expect((await partner(String(created.body.id))).mobile, "mobile saved exactly").toBe(apiUser.mobile);
    return `form: blank flagged by the browser, ${seen.join(", ")}; mobile pattern flags 5876543210 and spaces; stored name trimmed, Marathi shown, script as text; limit 120 (121/300 → 422); +91 refused every time (the profile edit strips it — see note); probes ${JSON.stringify(probes)}`;
  } finally {
    await context.close();
    await formUser.ctx.dispose();
    await apiUser.ctx.dispose();
  }
}, { ...local, partial: "+91 is refused on the application but stripped by the later profile edit (rider-profile.ts parsePhone) — each place is consistent with itself" });

qa("TC-FLD-091", "rider application vehicle: type required; the number is normalised or refused the same way every time (application vs profile edit); not required for a bicycle", async () => {
  const user = await freshCustomer("fld091");
  const seen: string[] = [];
  const problems: string[] = [];
  try {
    const noType = await call(user.ctx, "POST", "/api/delivery-partner", { fullName: "QA Vehicle", mobile: user.mobile });
    expect(noType.status, "no vehicle type").toBe(422);
    expect(Object.keys(noType.body?.error?.details?.fields ?? {}), "field named").toContain("vehicleType");
    seen.push("no type → 422 vehicleType");

    const created = await call(user.ctx, "POST", "/api/delivery-partner", application(user, { vehicleRegistrationNumber: "  mh12 ab 1234 " }));
    expectStatus(created, 201, "application with a lower-case number");
    const partnerId = String(created.body.id);
    const atApplication = (await partner(partnerId)).vehicle_registration_number;
    expectStatus(await call(user.ctx, "PATCH", "/api/delivery-partner/me", { vehicleRegistrationNumber: "  mh12 ab 1234 " }), 200, "same number on the profile edit");
    const atEdit = (await partner(partnerId)).vehicle_registration_number;
    seen.push(`"  mh12 ab 1234 " stored ${JSON.stringify(atApplication)} at application, ${JSON.stringify(atEdit)} after the profile edit`);
    if (atApplication !== atEdit) problems.push(`the same number is stored differently: application ${JSON.stringify(atApplication)} vs profile edit ${JSON.stringify(atEdit)}`);

    const symbols = await probe(user, { vehicleRegistrationNumber: "MH-12/AB@1234#" });
    const symbolsEdit = await call(user.ctx, "PATCH", "/api/delivery-partner/me", { vehicleRegistrationNumber: "MH-12/AB@1234#" });
    const storedSymbols = (await partner(partnerId)).vehicle_registration_number;
    seen.push(`"MH-12/AB@1234#": application ${symbols}, profile edit ${symbolsEdit.status} stored ${JSON.stringify(storedSymbols)}`);
    if (symbols === "accepted" || symbolsEdit.status === 200) problems.push(`a number with symbols is accepted unchanged (application ${symbols}, edit ${symbolsEdit.status} → ${JSON.stringify(storedSymbols)})`);

    const bicycle = await probe(user, { vehicleType: "BICYCLE", vehicleRegistrationNumber: null });
    seen.push(`bicycle with no number: ${bicycle}`);
    if (bicycle !== "accepted") problems.push(`bicycle without a number ${bicycle}`);
    expect(problems, seen.join("; ")).toEqual([]);
    return seen.join("; ");
  } finally {
    await user.ctx.dispose();
  }
}, { ...local, partial: "there is no 'on foot' vehicle type (Bicycle, Motorcycle, Scooter, Electric Vehicle, Other); the form marks the type required in the browser too (TC-DEL-014)" });

qa("TC-FLD-092", "rider KYC document and number: missing, oversized, wrong-type, disguised and empty files refused with a message (content checked); a valid photo accepted and listed; the KYC number validated and never shown in full", async ({ browser }) => {
  const rider = await freshRider("fld092");
  const { context, page } = await freshPage(browser, rider);
  const seen: string[] = [];
  const problems: string[] = [];
  try {
    const path = "/api/delivery-partner/me/documents";
    const noFile = await call(rider.ctx, "POST", path, undefined, { multipart: { docType: "AADHAAR" } as never });
    seen.push(`no file → ${noFile.status} "${noFile.body?.error?.message}"`);
    const files: [string, { name: string; mimeType: string; buffer: Buffer }][] = [
      ["oversized (2.1 MB)", { name: "big.png", mimeType: "image/png", buffer: Buffer.concat([png(400, 300), Buffer.alloc(2_100_000)]) }],
      ["text file", { name: "id.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") }],
      ["PDF renamed .jpg", { name: "id.jpg", mimeType: "image/jpeg", buffer: PDF_BYTES }],
      ["SVG renamed .jpg", { name: "id.jpg", mimeType: "image/jpeg", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300"/></svg>') }],
      ["empty", { name: "empty.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(0) }],
    ];
    if (noFile.status !== 422) problems.push(`no file → ${noFile.status}`);
    for (const [label, file] of files) {
      const res = await upload(rider.ctx, path, file, { docType: "AADHAAR" });
      seen.push(`${label} → ${res.status} "${res.body?.error?.message}"`);
      if (res.status !== 422) problems.push(`${label} → ${res.status}`);
    }
    const [none] = await db()<{ n: number }[]>`select count(*)::int as n from delivery_partner_documents where delivery_partner_id = ${rider.partnerId}`;
    if (none.n !== 0) problems.push(`${none.n} refused file(s) stored`);

    // The documents panel on /gig/profile.
    await page.goto("/gig/profile");
    const panel = page.getByTestId("rider-documents");
    await panel.locator("select").selectOption("AADHAAR");
    await panel.locator('input[type="file"]').setInputFiles({ name: "aadhaar.jpg", mimeType: "image/jpeg", buffer: PDF_BYTES });
    await panel.getByRole("button", { name: "Upload" }).click();
    await expect(panel.getByText("Upload a JPEG, PNG or WebP image.")).toBeVisible();
    await panel.locator('input[type="file"]').setInputFiles({ name: "aadhaar.png", mimeType: "image/png", buffer: png(400, 260) });
    await panel.getByRole("button", { name: "Upload" }).click();
    await expect(panel.getByText("Uploaded. Gokesari will review it.")).toBeVisible();
    await expect(panel.locator("li", { hasText: "Aadhaar card" })).toBeVisible();
    seen.push("panel: disguised PDF refused, PNG uploaded and listed as Aadhaar card");

    // KYC numbers: blank is allowed (optional), a wrong length must be refused.
    const numbers: Record<string, string> = {
      "application PAN blank": await probe(rider, { panNumber: null }),
      "application PAN 'ABC12' (wrong length)": await probe(rider, { panNumber: "ABC12" }),
      "application Aadhaar '12' (wrong length)": await probe(rider, { governmentIdType: "Aadhaar", governmentIdNumber: "12" }),
    };
    const pan = await call(rider.ctx, "POST", "/api/delivery-partner/me/change-request", { panNumber: "ABC12" });
    numbers["change request PAN 'ABC12'"] = pan.status === 422 ? "refused" : `HTTP ${pan.status}`;
    const aadhaar = await call(rider.ctx, "POST", "/api/delivery-partner/me/change-request", { governmentIdType: "Aadhaar", governmentIdNumber: "12" });
    numbers["change request Aadhaar '12'"] = aadhaar.status === 422 ? "refused" : `accepted (${aadhaar.status})`;
    const good = await call(rider.ctx, "POST", "/api/delivery-partner/me/change-request", { governmentIdType: "Aadhaar", governmentIdNumber: "432143214321" });
    expectStatus(good, 201, "a valid Aadhaar number");
    numbers["shown back as"] = String(good.body?.masked?.governmentIdNumber);
    seen.push(JSON.stringify(numbers));
    for (const [k, v] of Object.entries(numbers)) {
      if (/wrong length|'ABC12'|'12'/.test(k) && v !== "refused") problems.push(`${k} → ${v}`);
    }
    if (numbers["shown back as"] !== "…4321") problems.push(`number shown back as ${numbers["shown back as"]}`);
    expect(problems, seen.join("; ")).toEqual([]);
    return seen.join("; ");
  } finally {
    await rejectPending(rider.partnerId);
    await context.close();
    await rider.ctx.dispose();
  }
}, { ...local, partial: "KYC files are images only by design (C5-3, docs/gokesari-audit/ITEMS_A_E_2026-10-07.md), so a real PDF is refused too; the KYC number is optional at application ('can be added later')" });

qa("TC-FLD-093", "rider bank account number (digits only, 9–18) and IFSC (4 letters, 0, 6 characters; lower case converted or refused) at application and in a change request; saved values masked", async () => {
  const user = await freshCustomer("fld093");
  const seen: Record<string, string> = {};
  const problems: string[] = [];
  try {
    const created = await call(user.ctx, "POST", "/api/delivery-partner", application(user, { bankAccountNumber: "12345678", bankIfsc: "SBIN1001234" }));
    seen["application account 12345678 + IFSC SBIN1001234 (first)"] = created.status === 201 ? "accepted (201)" : `HTTP ${created.status}`;
    // Refused (422): apply without bank details, so the probes below see a duplicate when a value passes.
    if (created.status !== 201) expectStatus(await call(user.ctx, "POST", "/api/delivery-partner", application(user)), 201, "application without bank details");
    const partnerId = need((await partnerOf(user.id))?.id, "the application");
    const asApplicant = { ...user };
    seen["application both blank"] = await probe(asApplicant, { bankAccountNumber: null, bankIfsc: null });
    const cases: [string, Record<string, unknown>, "accepted" | "refused"][] = [
      ["account 8 digits", { bankAccountNumber: "12345678" }, "refused"],
      ["account 19 digits", { bankAccountNumber: "1234567890123456789" }, "refused"],
      ["account with letters", { bankAccountNumber: "12AB34CD5678" }, "refused"],
      ["IFSC 10 characters", { bankIfsc: "SBIN000123" }, "refused"],
      ["IFSC SBIN1001234", { bankIfsc: "SBIN1001234" }, "refused"],
      ["valid account + IFSC", { bankAccountNumber: "123456789012", bankIfsc: "SBIN0001234" }, "accepted"],
    ];
    for (const [label, body, want] of cases) {
      const got = await probe(asApplicant, body);
      seen[`application ${label}`] = got;
      if (got !== want) problems.push(`application ${label}: ${got}`);
    }
    for (const [label, body, want] of [...cases, ["IFSC lower case sbin0001234", { bankIfsc: "sbin0001234" }, "accepted"] as [string, Record<string, unknown>, "accepted"]]) {
      const res = await call(user.ctx, "POST", "/api/delivery-partner/me/change-request", body);
      const got = res.status === 201 ? "accepted" : res.status === 422 ? "refused" : `HTTP ${res.status}`;
      seen[`change request ${label}`] = res.status === 201 ? `${got} (shown ${JSON.stringify(res.body?.masked)})` : `${got}${res.body?.error?.message ? ` "${res.body.error.message}"` : ""}`;
      if (got !== want) problems.push(`change request ${label}: ${got}`);
      if (res.status === 201 && Object.values((res.body?.masked ?? {}) as Record<string, string>).some((v) => /\d{5,}/.test(v))) problems.push(`change request ${label} shown unmasked`);
    }
    if (created.status === 201) problems.unshift("application stored account 12345678 and IFSC SBIN1001234 (201)");
    const row = await partner(partnerId);
    expect(row.bank_account_number, "no plain account column").toBeNull();
    expect(problems, JSON.stringify(seen)).toEqual([]);
    return JSON.stringify(seen);
  } finally {
    const p = await partnerOf(user.id);
    if (p) await rejectPending(p.id);
    await user.ctx.dispose();
  }
}, { ...local, partial: "both blank is allowed (bank details are optional at application, 'can be added later'); the stored values are encrypted and never displayed — the change request shows the last 4 characters" });
