/**
 * Onboarding v2, Flow 2 — shop onboarding (docs/onboarding-v2-2026-11; drafts with flow_version 'v2').
 * Signed tier, staging. gk-shop holds an open v2 draft started on 26-Nov-2026 (identity done by SMS mock,
 * referral entered); it stops at GST / PAN: a new registration on staging needs an owner-agreed test PAN /
 * GSTIN (never a real person's or business's number — owner decision of 23-Nov-2026), so the fee payment,
 * shop type, licences, address / pin, agreement and go-live are not run here (TC-OV2-036).
 */
import { as, pageAs } from "../lib/actors";
import { call, expectStatus } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";

const OWNER = "shop" as const;

async function draft() {
  const res = await call(await as(OWNER), "GET", "/api/shops/registration-draft");
  expectStatus(res, 200, "GET /api/shops/registration-draft");
  if (!res.body?.v2) blocked("gk-shop has no open v2 registration draft (open /shop/register?new=1 as gk-shop to start one)");
  return res.body as {
    status: string;
    nextStep: string;
    v2: { identity: { termsAccepted: boolean; termsVersion: string; done: boolean }; fee: { byTurnover: boolean; slabs: Slab[]; flat: Omit<Slab, "slab" | "label"> | null; paid: boolean } };
  };
}
interface Slab { slab: number; label: string; basePaise: number; gstPaise: number; totalPaise: number }

qa(["TC-OV2-031"], "fee step amounts (owner 27-Nov-2026): the original turnover slabs ₹999 / ₹4,999 / ₹9,999 + GST 18% (₹1,178.82 for the first band)", async () => {
  const d = await draft();
  const { byTurnover, slabs, flat } = d.v2.fee;
  if (!byTurnover) {
    expect(flat, "flat fee when fees by turnover are off").toBeTruthy();
    return `fees by turnover off on this site: flat ₹${flat!.basePaise / 100} + GST = ₹${flat!.totalPaise / 100}`;
  }
  expect(slabs.map((s) => s.basePaise)).toEqual([99_900, 4_99_900, 9_99_900]);
  for (const s of slabs) {
    expect(s.gstPaise, `GST on ${s.label}`).toBe(Math.round(s.basePaise * 0.18));
    expect(s.totalPaise).toBe(s.basePaise + s.gstPaise);
  }
  return slabs.map((s) => `${s.label}: ₹${s.basePaise / 100} + ₹${s.gstPaise / 100} = ₹${s.totalPaise / 100}`).join("; ");
}, { tier: "signed", partial: "the amounts on the Pay screen and the sandbox payment itself are not reached (GST / PAN step, TC-OV2-036)" });

qa(["TC-OV2-032"], "the v2 steps refuse to run out of order: fee, licences and agreement before GST / PAN → 409 STEP_OPEN", async () => {
  const d = await draft();
  if (d.v2.fee.paid) blocked("the draft's fee is paid already");
  const owner = await as(OWNER);
  const seen: string[] = [];
  for (const [path, body] of [
    ["/api/shops/registration-draft/v2/fee", { slab: 1, shopName: "QA OV2 Shop" }],
    ["/api/shops/registration-draft/v2/licences", { licenceKey: "FSSAI", option: "LATER", promise: true }],
    ["/api/shops/registration-draft/v2/agreement", { action: "prepare" }],
  ] as const) {
    const res = await call(owner, "POST", path, body);
    expect(res.status, `${path}`).toBe(409);
    expect(res.body?.error?.details?.reason).toBe("STEP_OPEN");
    seen.push(`${path.split("/").pop()} → 409 (${res.body.error.message})`);
  }
  return seen.join("; ");
}, { tier: "signed" });

qa(["TC-OV2-033"], "identity step done once: Terms version recorded; a returning owner with verified e-mail and mobile skips the screen", async ({ browser }) => {
  const d = await draft();
  expect(d.v2.identity.termsAccepted).toBe(true);
  // QA D-168: the same Terms version /signin and the checkout sheet record (CURRENT_POLICY_VERSION).
  expect(d.v2.identity.termsVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(d.v2.identity.done).toBe(true);
  const { page, context } = await pageAs(browser, OWNER);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: "Register your shop" })).toBeVisible();
    await expect(page.getByTestId("v2-terms"), "identity screen not shown again").toHaveCount(0);
    return `terms ${d.v2.identity.termsVersion} accepted, identity done; /shop/register opens on step ${d.nextStep}`;
  } finally {
    await context.close();
  }
}, { tier: "signed" });

qa(["TC-OV2-034"], "admin → Shop documents → Registration licences: the queue (waiting / promised / verified / rejected) opens; API lists entries", async ({ browser }) => {
  const res = await call(await as("admin"), "GET", "/api/admin/registration-licences");
  expectStatus(res, 200, "GET /api/admin/registration-licences");
  const { page, context } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/shop-documents");
    await page.getByRole("link", { name: /Registration licences/ }).first().click();
    await expect(page).toHaveURL(/\/admin\/shop-documents\/registration-licences/);
    for (const tab of ["Waiting for the team", "Upload later (promised)", "Verified", "Rejected"]) await expect(page.locator("main")).toContainText(tab);
    return `queue opens from Shop documents; ${res.body.entries.length} entr(ies) on staging`;
  } finally {
    await context.close();
  }
}, { tier: "signed", partial: "approve / reject / open file need a licence entry, which needs the licence step (TC-OV2-036)" });

qa(["TC-OV2-036"], "GST/PAN → fee (Shop / Wholesale, sandbox pay page, leave unpaid → resume) → type → licences (Enter / Upload / Scan / Later, MUST_HAVE without Later) → address + pin → SLA → live / operator review", async () => {
  blocked(
    "not run on staging: a new registration's GST / PAN is checked live with the government (Sandbox.co.in) and needs an owner-agreed test PAN / GSTIN — owner decision 23-Nov-2026 (same block as TC-DOC-020…023). Covered locally by tests/integration/onboarding-v2-shop.test.ts (CI)",
  );
}, { tier: "signed" });
