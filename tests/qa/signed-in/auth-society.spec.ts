/**
 * Societies as residents, a society admin and operations see them (QA
 * package 1, Society module): registering (and its field rules), duplicates,
 * joining a verified society and being approved or declined, joining one that
 * is not verified, the dashboard's sections, its rules form, and who may act
 * on a society.
 *
 * Signed-in tier: customer 2 registers test societies (they stay APPLIED);
 * customer 1 joins the test society and leaves it again; the society admin
 * edits its own rules and puts them back. Without a society in the site's
 * test data the society-admin checks are blocked.
 */
import type { Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { keep, kept } from "../lib/auth-helpers";
import { defaultAddress } from "../lib/flows";
import { call, expectStatus, RUN } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 180_000 };
const APPLIED_KEY = "society-applied";

function theSociety() {
  const society = need(world().society, "a verified society in this site's test data");
  need(world().users.society, "the society admin account");
  return society;
}

async function mine(role: "customer" | "customer2") {
  const res = await call(await as(role), "GET", "/api/societies/mine");
  expectStatus(res, 200, "GET /api/societies/mine");
  return res.body as { membership: { id: string; role: string; status: string; unitLabel: string | null }; society: { id: string; name: string; status: string } }[];
}

async function leave(role: "customer" | "customer2", societyId: string) {
  for (const m of (await mine(role)).filter((r) => r.society.id === societyId)) {
    await call(await as(role), "PATCH", `/api/societies/members/${m.membership.id}`, { action: "remove" });
  }
}

async function registerForm(page: Page, values: { name: string; unit?: string; address?: string; area?: string; city?: string; pincode: string }) {
  await page.getByLabel("Society name", { exact: true }).fill(values.name);
  await page.getByLabel("Your flat / unit", { exact: true }).fill(values.unit ?? "");
  await page.getByLabel("Address", { exact: true }).fill(values.address ?? "QA Society Road");
  await page.getByLabel("Area", { exact: true }).fill(values.area ?? "Kothrud");
  await page.getByLabel("City", { exact: true }).fill(values.city ?? "Pune");
  await page.getByLabel("PIN code", { exact: true }).fill(values.pincode);
}

/* ======================================================== registration */

qa("TC-SOC-001", "register a society from /society: it is APPLIED and the registrant is its active ADMIN", async ({ browser }) => {
  const name = `QA Towers ${RUN}`;
  const { context, page } = await pageAs(browser, "customer2");
  try {
    await page.goto("/society");
    await registerForm(page, { name, unit: "B-12", pincode: "411038" });
    await page.getByRole("button", { name: "Register society" }).click();
    await expect(page.getByText("Registered — our team will verify the society shortly.")).toBeVisible();
    const row = (await mine("customer2")).find((r) => r.society.name === name);
    expect(row, "listed in my societies").toBeTruthy();
    expect([row!.society.status, row!.membership.role, row!.membership.status, row!.membership.unitLabel]).toEqual(["APPLIED", "ADMIN", "ACTIVE", "B-12"]);
    await page.reload();
    await expect(page.getByText(name).first()).toBeVisible();
    await expect(page.getByText("admin · B-12 · society applied").first()).toBeVisible();
    keep(APPLIED_KEY, { id: row!.society.id, name });
    return `"${name}" APPLIED; customer 2 is its ADMIN (ACTIVE, unit B-12)`;
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true, partial: "'pending verification' is the society's APPLIED status; the operator's verification is TC-SOC-003" });

qa("TC-SOC-002", "registering the same name and PIN again is refused (any letter case)", async ({ browser }) => {
  const first = kept<{ id: string; name: string }>(APPLIED_KEY) ?? blocked("needs the society registered by TC-SOC-001");
  const api = await call(await as("customer2"), "POST", "/api/societies", { name: first.name.toUpperCase(), addressLine1: "Other road", city: "Pune", pincode: "411038" });
  expect(api.status, "API duplicate").toBe(409);
  expect(api.body.error.message).toBe("This society is already registered — ask to join it instead.");
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/society");
    await registerForm(page, { name: first.name, pincode: "411038" });
    await page.getByRole("button", { name: "Register society" }).click();
    await expect(page.getByText("This society is already registered — ask to join it instead.")).toBeVisible();
    const again = (await mine("customer")).filter((r) => r.society.name.toLowerCase() === first.name.toLowerCase());
    expect(again, "no second society for customer 1").toEqual([]);
    return `"${first.name.toUpperCase()}" + 411038 → 409 (API); the same from the page → "already registered — ask to join it instead"`;
  } finally {
    await context.close();
  }
}, signed);

qa("TC-FLD-104", "society registration fields: blank, spaces, 1 character and over 120 refused; script shown as text; Hindi kept; outer spaces trimmed; 6-digit PIN rule", async ({ browser }) => {
  const ctx = await as("customer2");
  const post = (name: string, pincode = "411038") => call(ctx, "POST", "/api/societies", { name, addressLine1: "QA Society Road", city: "Pune", pincode });
  const out: string[] = [];
  for (const name of ["", "   ", "A"]) {
    const res = await post(name);
    expect(res.status, `name ${JSON.stringify(name)}`).toBe(422);
  }
  out.push("blank, spaces-only and 1 character → 422");
  const long = await post("x".repeat(300));
  expect(long.status, "300 characters").toBe(422);
  const at = await post(`QA ${RUN} ${"y".repeat(110)}`.slice(0, 120));
  expectStatus(at, 201, "120 characters");
  out.push("300 chars → 422, 120 chars accepted (limit 120)");
  const trimmed = await post(`   QA Trim Soc ${RUN}   `);
  expectStatus(trimmed, 201, "outer spaces");
  expect(trimmed.body.name).toBe(`QA Trim Soc ${RUN}`);
  out.push("outer spaces trimmed");
  for (const pincode of ["41103", "4110381", "abcdef", "41 038"]) {
    const res = await post(`QA Pin ${pincode} ${RUN}`, pincode);
    expect(res.status, `PIN ${pincode}`).toBe(422);
  }
  out.push("PIN 5/7 digits, letters, a space → 422");
  const script = `<script>alert(1)</script> QA ${RUN}`;
  const hindi = `श्री गणेश सोसायटी ${RUN}`;
  for (const name of [script, hindi]) expectStatus(await post(name), 201, `name ${name.slice(0, 12)}`);
  const { context, page } = await pageAs(browser, "customer2");
  let alerted = false;
  page.on("dialog", async (d) => {
    alerted = true;
    await d.dismiss();
  });
  try {
    await page.goto("/society");
    await expect(page.getByText(script, { exact: true }).first(), "script shown as text").toBeVisible();
    await expect(page.getByText(hindi, { exact: true }).first(), "Hindi kept").toBeVisible();
    expect(alerted, "no script ran").toBe(false);
    await page.getByLabel("Society name", { exact: true }).fill("ab");
    await page.getByLabel("PIN code", { exact: true }).fill("411038");
    await expect(page.getByRole("button", { name: "Register society" }), "under 3 characters").toBeDisabled();
    await page.getByLabel("Society name", { exact: true }).fill("QA Disabled");
    await page.getByLabel("PIN code", { exact: true }).fill("4110");
    await expect(page.getByRole("button", { name: "Register society" }), "short PIN").toBeDisabled();
    out.push("script and Hindi names saved and shown as plain text; the button stays disabled for a short name or PIN");
  } finally {
    await context.close();
  }
  return out.join("; ");
}, { ...signed, partial: "a PIN starting with 0 is accepted (known defect D-04, not asserted); duplicates are TC-SOC-002" });

qa("TC-SOC-005", "asking to join a society that is not verified yet is refused", async () => {
  const applied = kept<{ id: string; name: string }>(APPLIED_KEY) ?? blocked("needs the APPLIED society from TC-SOC-001");
  const res = await call(await as("customer"), "POST", `/api/societies/${applied.id}/members`, { unitLabel: "A-1" });
  expect(res.status).toBe(409);
  expect(res.body.error.message).toBe("This society is not open for residents yet.");
  expect((await mine("customer")).some((r) => r.society.id === applied.id), "no membership created").toBe(false);
  return `POST /api/societies/{APPLIED}/members → 409 "${res.body.error.message}"`;
}, signed);

/* ================================================ the society's own pages */

qa("TC-SOC-008", "society dashboard: rules, residents, authorised riders, partner shops and deliveries", async ({ browser }) => {
  const society = theSociety();
  const { context, page } = await pageAs(browser, "society");
  try {
    await page.goto(`/society/${society.id}`);
    await expect(page.getByRole("heading", { name: society.name })).toBeVisible();
    const sections = ["Rules & instructions", /^Residents \(\d+\)$/, "Authorised riders", "Shops for our residents", "Deliveries to the society (last 7 days)"] as const;
    for (const name of sections) await expect(page.getByRole("heading", { name }), String(name)).toBeVisible();
    return `${society.name}: ${sections.map(String).join(", ")}`;
  } finally {
    await context.close();
  }
}, { ...signed, mobile: true });

qa(["TC-SOC-004", "TC-SOC-010"], "a resident asks to join and is approved; another request is declined and cannot link an address; residents, other societies' admins are refused (403), operations allowed", async ({ browser }) => {
  const society = theSociety();
  const unit = `C-${RUN.slice(-4)}`;
  await leave("customer", society.id);
  await leave("customer2", society.id);
  const out: string[] = [];
  const resident = await pageAs(browser, "customer");
  try {
    await resident.page.goto("/society");
    const join = resident.page.locator("section").filter({ has: resident.page.getByRole("heading", { name: "Join a society" }) });
    await join.getByLabel("Search societies").fill(society.name);
    await join.getByLabel("Your flat or unit").fill(unit);
    await join.getByRole("button", { name: "Search", exact: true }).click();
    const result = join.locator("li").filter({ hasText: society.name });
    await result.getByRole("button", { name: "Ask to join" }).click();
    await expect(resident.page.getByText("Request sent to the society.")).toBeVisible();
  } finally {
    await resident.context.close();
  }
  let membership = (await mine("customer")).find((r) => r.society.id === society.id);
  expect(membership?.membership.status, "after asking").toBe("PENDING");
  out.push("customer 1 asked to join → PENDING");
  const c2Ask = await call(await as("customer2"), "POST", `/api/societies/${society.id}/members`, { unitLabel: `D-${RUN.slice(-4)}` });
  expectStatus(c2Ask, 201, "customer 2 asks too");
  const admin = await pageAs(browser, "society");
  try {
    await admin.page.goto(`/society/${society.id}`);
    const members = admin.page.getByTestId("society-members");
    await members.locator("div").filter({ hasText: unit }).last().getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => (await mine("customer")).find((r) => r.society.id === society.id)?.membership.status).toBe("ACTIVE");
    await members.locator("div").filter({ hasText: `D-${RUN.slice(-4)}` }).last().getByRole("button", { name: "Decline" }).click();
    await expect.poll(async () => (await mine("customer2")).some((r) => r.society.id === society.id), { message: "the declined request is gone" }).toBe(false);
  } finally {
    await admin.context.close();
  }
  out.push("the society admin approved it (ACTIVE) and declined customer 2's");
  const c2Address = need(await defaultAddress("customer2"), "customer 2's address");
  const link = await call(await as("customer2"), "PUT", `/api/addresses/${c2Address.id}/society`, { societyId: society.id });
  expect(link.status, "declined: cannot link an address").toBe(403);
  out.push("declined customer 2 cannot link an address (403)");
  // TC-SOC-010: a resident, another society's admin and operations.
  membership = (await mine("customer")).find((r) => r.society.id === society.id);
  expect(membership?.membership.role).toBe("RESIDENT");
  const resCtx = await as("customer");
  const residentApi = [await call(resCtx, "GET", `/api/societies/${society.id}`), await call(resCtx, "PATCH", `/api/societies/${society.id}`, { deliveryInstructions: "resident edit" })];
  expect(residentApi.map((r) => r.status), "a resident on the dashboard API").toEqual([403, 403]);
  const page = await pageAs(browser, "customer");
  try {
    const res = await page.page.goto(`/society/${society.id}`);
    expect(res?.status(), "a resident opening the dashboard").toBe(404);
  } finally {
    await page.context.close();
  }
  const applied = kept<{ id: string }>(APPLIED_KEY);
  if (applied) {
    const otherAdmin = await as("customer2");
    const cross = [
      await call(otherAdmin, "PATCH", `/api/societies/${society.id}`, { deliveryInstructions: "cross-society edit" }),
      await call(otherAdmin, "POST", `/api/societies/${society.id}/riders`, { mobile: "9876543210" }),
      await call(otherAdmin, "PATCH", `/api/societies/members/${membership!.membership.id}`, { action: "remove" }),
    ];
    expect(cross.map((r) => r.status), "admin of another society").toEqual([403, 403, 403]);
    out.push("customer 2 (admin of another society) → 403 on PATCH, add rider, remove member");
  }
  const ops = await as("ops");
  const view = await call(ops, "GET", `/api/societies/${society.id}`);
  expectStatus(view, 200, "operations opens it");
  const same = await call(ops, "PATCH", `/api/societies/${society.id}`, { deliveryInstructions: view.body.society.deliveryInstructions ?? null });
  expectStatus(same, 200, "operations edits it");
  out.push("resident: dashboard page 404, API 403/403; operations: GET and PATCH 200");
  await leave("customer", society.id);
  return out.join("; ");
}, { ...signed, timeout: 240_000, partial: "the resident's dashboard page answers 404 (it does not reveal the society) rather than 403; the API answers 403" });

qa("TC-FLD-105", "society rules: blank accepted, over 500 characters refused, script and Hindi shown as text, entry modes from the list only, a bad security contact refused", async ({ browser }) => {
  const society = theSociety();
  const ctx = await as("society");
  const original = (await call(ctx, "GET", `/api/societies/${society.id}`)).body.society as Record<string, unknown>;
  const patch = (body: Record<string, unknown>) => call(ctx, "PATCH", `/api/societies/${society.id}`, body);
  const out: string[] = [];
  try {
    expectStatus(await patch({ deliveryInstructions: "" }), 200, "blank instructions");
    expect((await patch({ deliveryInstructions: "x".repeat(600) })).status, "600 characters").toBe(422);
    expectStatus(await patch({ deliveryInstructions: "y".repeat(500) }), 200, "500 characters");
    out.push("blank accepted; 600 chars → 422, 500 accepted (limit 500)");
    for (const mode of ["OPEN", "CALL_RESIDENT", "PRE_APPROVAL", "DROP_AT_GATE"]) expectStatus(await patch({ gateEntryMode: mode }), 200, mode);
    expect((await patch({ gateEntryMode: "LADDER" })).status, "a mode not in the list").toBe(422);
    out.push("4 entry modes saved, an unlisted one → 422");
    const refused: string[] = [];
    const accepted: string[] = [];
    for (const contact of ["abc", "12", "a@b.com", "123456", "98765@4321"]) {
      const res = await patch({ gateContactPhone: contact });
      (res.status === 422 ? refused : accepted).push(contact);
    }
    expectStatus(await patch({ gateContactPhone: "+91 98765 43210" }), 200, "a valid mobile");
    const script = `<script>alert(1)</script> gate ${RUN}`;
    const hindi = `मुख्य द्वार ${RUN}`;
    const { context, page } = await pageAs(browser, "society");
    let alerted = false;
    page.on("dialog", async (d) => {
      alerted = true;
      await d.dismiss();
    });
    try {
      for (const text of [script, hindi]) {
        expectStatus(await patch({ deliveryInstructions: text }), 200, "instructions");
        await page.goto(`/society/${society.id}`);
        await expect(page.getByLabel("Gate / parking / access instructions for riders")).toHaveValue(text);
      }
      expect(alerted, "no script ran").toBe(false);
      await expect(page.getByLabel("Gate / parking / access instructions for riders"), "the field stops at 500").toHaveAttribute("maxlength", "500");
    } finally {
      await context.close();
    }
    out.push("script and Hindi instructions saved and shown as text");
    expect(accepted, `security contacts accepted that are not a valid mobile: ${accepted.join(", ")} (refused: ${refused.join(", ")})`).toEqual([]);
    return `${out.join("; ")}; contacts refused: ${refused.join(", ")}; +91 98765 43210 accepted`;
  } finally {
    await patch({
      deliveryInstructions: original.deliveryInstructions ?? null,
      gateEntryMode: original.gateEntryMode,
      gateContactName: original.gateContactName ?? null,
      gateContactPhone: original.gateContactPhone ?? null,
    });
  }
}, { ...signed, partial: "the security contact is a phone field: an email address is refused rather than accepted (src/components/society-actions.tsx 'Security desk phone')" });

