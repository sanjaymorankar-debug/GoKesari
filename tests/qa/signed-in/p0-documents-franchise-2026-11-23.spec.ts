/**
 * P0 cases of the 23-Nov-2026 plan (docs/testing/manual/cases-added-2026-11-23.json) for shop documents and
 * licences (DF-08 / DF-09, PRs #458 / #467 / #471), franchise zones (#465 / #478), referral code moves (#473)
 * and the dealership platform (#503) — the parts that run with the existing staging test accounts.
 *
 * Signed tier (test.gokesari.com and the local server). What it may write, and how it is put back:
 *   - TC-DOC-001 clicks Approve on a pending paid food shop without a valid FSSAI licence, which the server must
 *     refuse; TC-DOC-002 approves such a shop with "Approve without documents" only when it is clearly a test shop.
 *     None exists on staging today, so both (and TC-DOC-003) are blocked with that reason.
 *   - TC-REFM-015 raises one SHOPS referral-move request for an E2E test shop as the staging admin, uploads its two
 *     dummy consent letters, checks the admin's own approve / reject are refused, and cancels the request in a
 *     finally block. No move is ever approved.
 *   - TC-DPLT-038 saves one DRAFT version labelled "QA draft 23-Nov — delete" on a dealer scheme and deletes it in
 *     a finally block. Nothing is published.
 * Every other check only reads or sends requests the server must refuse; the bodies of refused writes are
 * invalid on purpose, so a broken guard could not change a rule, a zone, a fee or a franchise (it would answer
 * 422 / 404 instead of 403, and the check fails). No rule, flag, fee, coupon, zone, scheme or dealer is changed.
 */
import type { Locator, Page } from "@playwright/test";

import { as, me, pageAs } from "../lib/actors";
import { anonymous, call, expectStatus, RUN, why, type Answer } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { NO_SUCH_ID } from "../lib/routes";
import { BASE_URL } from "../lib/target";
import { world, type Role } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 300_000 };

const NO_ACCESS = "You do not have access to this area.";
const SIGN_IN = "Please sign in to continue.";
/** A file that passes the server's PDF sniffing: a dummy letter, never a real consent or licence. */
const DUMMY_PDF = Buffer.from("%PDF-1.4\n% QA dummy letter for a staging test (not a real document)\n%%EOF\n");

/* ------------------------------------------------------------------ helpers */

/** Where a redirect answer points (path + query, decoded), or null when it is not a redirect. */
function redirectTarget(res: Answer): string | null {
  if (![301, 302, 303, 307, 308].includes(res.status) || !res.location) return null;
  const url = new URL(res.location, BASE_URL);
  return decodeURIComponent(`${url.pathname}${url.search}`);
}

/** GET `path` as `role` (or a guest) without following redirects. */
async function getPage(role: Role | "guest", path: string): Promise<Answer> {
  if (role !== "guest") return call(await as(role), "GET", path);
  const guest = await anonymous();
  try {
    return await call(guest, "GET", path);
  } finally {
    await guest.dispose();
  }
}

/** The redirects a page answers `role` with, hop by hop (at most three), e.g. ["/admin", "/"]. */
async function redirectChain(role: Role | "guest", path: string): Promise<string[]> {
  const hops: string[] = [];
  let next: string | null = path;
  for (let i = 0; i < 3 && next; i++) {
    const res = await getPage(role, next);
    next = redirectTarget(res);
    if (next) hops.push(next);
  }
  return hops;
}

/** The answer is `status` with exactly `message`. */
function expectRefusal(res: Answer, status: number, message: string, what: string) {
  expect(res.status, `${what} — ${why(res)}`).toBe(status);
  expect(res.body?.error?.message, `${what} — ${why(res)}`).toBe(message);
}

/** Open `path` in a browser as `role` and return where the browser ended (pathname). */
async function landing(page: Page, path: string): Promise<string> {
  await page.goto(path);
  return new URL(page.url()).pathname;
}

async function featureFlag(key: string): Promise<boolean | null> {
  const res = await call(await as("admin"), "GET", "/api/admin/feature-flags");
  expectStatus(res, 200, "admin reads the feature flags");
  const flag = (res.body.flags as { key: string; enabled: boolean }[]).find((f) => f.key === key);
  return flag ? flag.enabled : null;
}

/* ============================================================ shop documents */

const FSSAI_REFUSAL =
  "A shop that sells food needs a valid FSSAI licence or registration before registration can be completed. Upload it on My Shop → Upload documents.";

interface HeldShop {
  id: string;
  name: string;
}

/** The card of one pending shop on Shop approvals: the block holding its details and its Approve / Reject buttons. */
function cardOf(page: Page, shopId: string): Locator {
  return page
    .locator(`a[href="/admin/shops/${shopId}/documents"]`)
    .locator("xpath=ancestor::div[.//button[normalize-space()='Reject']][1]");
}

/**
 * A pending, paid food shop at stage Verified with no valid FSSAI licence on file, as Shop approvals shows it to
 * the signed-in staff member (badge "FSSAI licence missing / expired", "fee paid", Approve enabled). Blocks the case
 * when there is none: the plan's precondition cannot be arranged on staging without registering and paying a shop.
 */
async function heldFoodShop(page: Page): Promise<HeldShop> {
  await page.goto("/admin/console/shops");
  await expect(page.getByRole("heading", { name: "Shop approvals" })).toBeVisible();
  const flagged = page.getByTestId("fssai-needed");
  const n = await flagged.count();
  if (n === 0) {
    const empty = await page.getByText("No shops waiting for approval.").isVisible();
    blocked(
      empty
        ? "no pending shop on test.gokesari.com (Shop approvals: “No shops waiting for approval.”), so there is no paid food shop held for its FSSAI licence"
        : "no pending food shop without a valid FSSAI licence on test.gokesari.com (no “FSSAI licence missing / expired” card on Shop approvals)",
    );
  }
  for (let i = 0; i < n; i++) {
    const header = flagged.nth(i).locator("xpath=ancestor::div[.//button[normalize-space()='Reject']][1]");
    const href = await header.getByTestId("upload-for-owner").getAttribute("href");
    const id = href?.match(/\/admin\/shops\/([0-9a-f-]{36})\/documents/)?.[1];
    if (!id) continue;
    const paid = (await header.getByText(/^fee (paid|waived)$/).count()) > 0;
    const approvable = await header.getByRole("button", { name: "Approve", exact: true }).isEnabled();
    if (!paid || !approvable) continue;
    const name = (await header.locator("p").first().innerText()).trim();
    return { id, name };
  }
  blocked(`${n} pending food shop(s) without a valid FSSAI licence on staging, none both paid and at stage Verified (the case's precondition)`);
}

qa("TC-DOC-001", "a pending paid food shop without a valid FSSAI licence is flagged on its approval card (badge, note, upload link, Approve without documents) and a plain Approve is refused with 409; the shop stays pending", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    const shop = await heldFoodShop(page);
    const card = cardOf(page, shop.id);
    await expect(card.getByText(/^FSSAI licence (missing|expired)$/)).toBeVisible();
    await expect(card.getByTestId("fssai-needed")).toHaveText(
      /^FSSAI: (no valid licence on file\.|the licence on file has expired\.) Upload the copy the owner sent you, or use Approve without documents — the owner then has 30 days to upload it\.$/,
    );
    await expect(card.getByRole("link", { name: "Upload FSSAI for owner →" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Approve without documents" })).toBeVisible();
    const answered = page.waitForResponse((r) => r.url().includes(`/api/shops/${shop.id}/approve`) && r.request().method() === "POST");
    await card.getByRole("button", { name: "Approve", exact: true }).click();
    const res = await answered;
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    expect(res.status(), `POST /api/shops/${shop.id}/approve — ${body?.error?.message ?? ""}`).toBe(409);
    expect(body?.error?.message).toBe(FSSAI_REFUSAL);
    await expect(page.getByText(FSSAI_REFUSAL)).toBeVisible();
    await page.reload();
    await expect(cardOf(page, shop.id), "the shop is still in the approval queue").toBeVisible();
    return `${shop.name} (${shop.id}): flagged, Approve → 409 "${FSSAI_REFUSAL}", still pending`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "that a signup-wizard food shop no longer gets the 90-day FSSAI grace needs the database (developer)" });

qa("TC-DOC-003", "an operator sees the FSSAI flag and the upload link but no Approve without documents, and the approval API refuses waiveFssai / waiveDocuments from an operator with 403; the shop stays pending", async ({ browser }) => {
  const { context: adminContext, page: adminPage } = await pageAs(browser, "admin");
  let shop: HeldShop;
  try {
    shop = await heldFoodShop(adminPage);
  } finally {
    await adminContext.close();
  }
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/admin/console/shops");
    const card = cardOf(page, shop.id);
    await expect(card.getByText(/^FSSAI licence (missing|expired)$/)).toBeVisible();
    await expect(card.getByTestId("fssai-needed")).toHaveText(/^FSSAI: (no valid licence on file\.|the licence on file has expired\.) Upload the copy the owner sent you\.$/);
    await expect(card.getByRole("link", { name: "Upload FSSAI for owner →" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Approve without documents" })).toHaveCount(0);
  } finally {
    await context.close();
  }
  const ops = await as("ops");
  const waiveFssai = await call(ops, "POST", `/api/shops/${shop.id}/approve`, { classification: "GREEN", waiveFssai: { reason: "Owner will upload next week" } });
  expectRefusal(waiveFssai, 403, "Only an admin can approve a shop without its must-have documents.", "operator approves with waiveFssai");
  const waiveDocuments = await call(ops, "POST", `/api/shops/${shop.id}/approve`, { classification: "GREEN", waiveDocuments: { reason: "Owner will upload next week" } });
  expectRefusal(waiveDocuments, 403, "Only an admin can approve a shop without its documents.", "operator approves with waiveDocuments");
  const { context: checkContext, page: checkPage } = await pageAs(browser, "admin");
  try {
    await checkPage.goto("/admin/console/shops");
    await expect(cardOf(checkPage, shop.id), "the shop is still pending").toBeVisible();
  } finally {
    await checkContext.close();
  }
  return `${shop.name}: operator card without "Approve without documents"; waiveFssai → 403, waiveDocuments → 403; still pending`;
}, { ...signed, partial: "that no shop_fssai_waivers row was written needs the database (developer); the shop still pending is read from Shop approvals" });

qa("TC-DOC-002", "Approve without documents: the confirmation names the FSSAI licence and the 30-day due date, and a test food shop goes live", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    const shop = await heldFoodShop(page);
    // QA agent rule: approve only a shop that is plainly test data.
    if (!/\b(e2e|qa|test)\b/i.test(shop.name)) blocked(`the only held food shop on staging, “${shop.name}”, is not plainly a test shop; approving it is left to a person`);
    const card = cardOf(page, shop.id);
    await card.getByRole("button", { name: "Approve without documents" }).click();
    const panel = page.getByLabel("Reason for approving without documents").locator("xpath=ancestor::div[2]");
    await expect(panel).toContainText(`Approve ${shop.name} as Green without verified documents (`);
    await expect(panel).toContainText(/FSSAI licence\)\. The shop goes live now; your name and reason are recorded\. The registration fee is still checked\. The owner must upload a valid FSSAI licence within 30 days \(by [^)]+\); they are reminded on the 1st and 15th, and the shop is suspended automatically if it is still missing then\./);
    await page.getByLabel("Reason for approving without documents").fill("Owner sent the licence by e-mail; uploading it");
    const answered = page.waitForResponse((r) => r.url().includes(`/api/shops/${shop.id}/approve`) && r.request().method() === "POST");
    await page.getByRole("button", { name: "Confirm approval" }).click();
    const res = await answered;
    expect(res.status(), "Confirm approval").toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("APPROVED");
    return `${shop.name} approved without its FSSAI licence (due in 30 days)`;
  } finally {
    await context.close();
  }
}, {
  ...signed,
  partial:
    "shop_fssai_waivers, the FSSAI row's grace_until and the audit row need the database (developer); the owner's notifications and mail need the owner's session (only shop A's owner is a staging test account)",
});

qa("TC-DOC-010", "Upload documents for a shop opens only for admins and full operators: guest to sign-in with the callback, customer / shop owner / operator-limited sent to /admin and on to the home page, another shop's documents API 403, guest API 401, a bad id the 404 page", async ({ browser }) => {
  const shopB = need(world().shops.B?.id, "a shop the testers do not own (shop B)");
  const path = `/admin/shops/${shopB}/documents`;

  // 1. Signed out.
  const guestPage = await getPage("guest", path);
  expect(redirectTarget(guestPage), `guest GET ${path} → ${guestPage.status}`).toBe(`/signin?callbackUrl=${path}`);

  // 2. Customer, a shop owner of another shop, operator-limited: /admin, then the home page; the panel never shows.
  const sentAway: string[] = [];
  for (const role of ["customer", "shop", "oplim"] as const) {
    expect(await redirectChain(role, path), `${role} opens ${path}`).toEqual(["/admin", "/"]);
    const { context, page } = await pageAs(browser, role);
    try {
      const at = await landing(page, path);
      expect(at, `${role} ends on`).toBe("/");
      await expect(page.getByTestId("admin-shop-documents-page")).toHaveCount(0);
    } finally {
      await context.close();
    }
    sentAway.push(role);
  }

  // 3. The shop owner of shop A on shop B: refused before anything is read or stored.
  const owner = await as("shop");
  expectRefusal(await call(owner, "GET", `/api/shops/${shopB}/documents`), 403, "This shop does not belong to you.", "shop owner GET another shop's documents");
  const read = await call(owner, "POST", `/api/shops/${shopB}/documents/read`, undefined, {
    multipart: { file: { name: "qa-dummy.pdf", mimeType: "application/pdf", buffer: DUMMY_PDF }, docType: "FSSAI" },
  });
  expectRefusal(read, 403, "This shop does not belong to you.", "shop owner POST documents/read for another shop");

  // 4. Signed out, the API.
  const guest = await anonymous();
  try {
    expectRefusal(await call(guest, "GET", `/api/shops/${shopB}/documents`), 401, SIGN_IN, "guest GET documents");
  } finally {
    await guest.dispose();
  }

  // 5. Admin, a bad id: the 404 page.
  expect((await getPage("admin", "/admin/shops/not-a-uuid/documents")).status, "admin GET /admin/shops/not-a-uuid/documents").toBe(404);
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/shops/not-a-uuid/documents");
    await expect(page.getByTestId("not-found-state")).toBeVisible();
  } finally {
    await context.close();
  }
  return `guest → /signin?callbackUrl=${path}; ${sentAway.join(", ")} → /admin → /; shop owner on shop B: GET and POST read → 403; guest API → 401; not-a-uuid → 404 page`;
}, signed);

interface DocRulesView {
  documents: { key: string; label: string; builtIn: boolean; status: string; rules: { id: string; scope: string; scopeLabel: string; level: "MUST_HAVE" | "PROMISE" | "OPTIONAL" }[] }[];
}

const LEVEL_LABELS = { MUST_HAVE: "Must-have before go-live", PROMISE: "Upload later, on the owner's promise", OPTIONAL: "Optional" } as const;

/** The rules as a comparable list (document, status, scope, level). */
function ruleSnapshot(view: DocRulesView) {
  return view.documents.flatMap((d) => [`${d.key}:${d.status}`, ...d.rules.map((r) => `${d.key}:${r.id}:${r.scope}:${r.level}`)]).sort();
}

qa("TC-DOC-043", "only an admin changes the shop document rules: the operator reads them (levels as badges, no controls) and every write is 403; customer and shop owner are sent home and refused by the API; a guest goes to sign-in and gets 401", async ({ browser }) => {
  const ops = await as("ops");
  const before = await call(ops, "GET", "/api/admin/shop-document-rules");
  expectStatus(before, 200, "the operator reads the rules");
  const view = before.body as DocRulesView;
  expect(view.documents.length).toBeGreaterThan(0);
  const rules = view.documents.flatMap((d) => d.rules);
  expect(rules.length, "rules on the page").toBeGreaterThan(0);
  const added = view.documents.find((d) => !d.builtIn);

  // 1. The operator's page: the note, levels as badges, no selects or buttons that change anything.
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/admin/shop-documents");
    await expect(page.getByText("Only an admin can change these rules.")).toBeVisible();
    const cards = page.locator('[data-testid^="doc-rules-"]');
    await expect(cards).toHaveCount(view.documents.length);
    await expect(cards.getByRole("combobox")).toHaveCount(0);
    for (const name of ["Remove", "Add rule", "Edit document", "Switch off", "Switch on"]) await expect(page.getByRole("button", { name, exact: true }), name).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add a document" })).toHaveCount(0);
    for (const doc of view.documents) {
      const card = page.getByTestId(`doc-rules-${doc.key.replace(/^DOC:/, "").toLowerCase()}`);
      // One line per rule: the scope, (for promise / must-have) "shops already live: by …", and the level as a badge.
      for (const rule of doc.rules) {
        const line = card.getByRole("listitem").filter({ has: page.getByText(rule.scopeLabel, { exact: true }) });
        await expect(line, `${doc.key} ${rule.scope}`).toHaveCount(1);
        await expect(line.getByText(LEVEL_LABELS[rule.level], { exact: true }), `${doc.key} ${rule.scope} level badge`).toBeVisible();
      }
    }
  } finally {
    await context.close();
  }

  // 2. The operator's writes. Invalid bodies and an id that matches no rule: only the role check answers 403;
  //    a broken check could not change a rule (it would answer 422 / 404 and this check fails).
  const key = added?.key ?? "DOC:QA_NO_SUCH_DOCUMENT";
  expectRefusal(await call(ops, "PUT", "/api/admin/shop-document-rules", {}), 403, NO_ACCESS, "operator PUT shop-document-rules");
  expectRefusal(await call(ops, "POST", "/api/admin/shop-document-types", {}), 403, NO_ACCESS, "operator POST shop-document-types");
  expectRefusal(await call(ops, "PATCH", `/api/admin/shop-document-types/${encodeURIComponent(key)}`, { status: "QA_NOT_A_STATUS" }), 403, NO_ACCESS, "operator PATCH shop-document-types/<key>");
  expectRefusal(await call(ops, "DELETE", `/api/admin/shop-document-rules/${NO_SUCH_ID}`), 403, NO_ACCESS, "operator DELETE shop-document-rules/<id>");
  const after = await call(ops, "GET", "/api/admin/shop-document-rules");
  expectStatus(after, 200, "rules read again");
  expect(ruleSnapshot(after.body as DocRulesView), "the rules after the refused writes").toEqual(ruleSnapshot(view));

  // 3. Customer and shop owner.
  for (const role of ["customer", "shop"] as const) {
    expect(redirectTarget(await getPage(role, "/admin/shop-documents")), `${role} opens /admin/shop-documents`).toBe("/");
    expectRefusal(await call(await as(role), "GET", "/api/admin/shop-document-rules"), 403, NO_ACCESS, `${role} GET shop-document-rules`);
  }

  // 4. Signed out.
  expect(redirectTarget(await getPage("guest", "/admin/shop-documents")), "guest opens /admin/shop-documents").toBe("/signin");
  const guest = await anonymous();
  try {
    expectRefusal(await call(guest, "GET", "/api/admin/shop-document-rules"), 401, SIGN_IN, "guest GET shop-document-rules");
  } finally {
    await guest.dispose();
  }
  return `operator: note shown, ${rules.length} levels as badges, no controls; PUT / POST / PATCH ${key} / DELETE → 403 "${NO_ACCESS}", rules unchanged; customer, shop owner → / and API 403; guest → /signin and API 401${added ? "" : " (no admin-added document on staging: PATCH used a key that matches none)"}`;
}, signed);

/* ================================================================ franchise */

const FRANCHISE_TABS = ["Overview", "Zones", "Zone status", "Fees", "Areas", "Coupons", "Franchises", "Monthly points", "Expiring", "Attribution", "Commission & bonus", "Settings", "Reports", "Send log"];

/** The tab buttons of Admin → Franchise, without their counts ("Expiring (2)" → "Expiring"). */
async function franchiseTabs(page: Page): Promise<string[]> {
  const nav = page.getByRole("navigation", { name: "Franchise admin" });
  await expect(nav).toBeVisible({ timeout: 60_000 });
  return (await nav.getByRole("button").allInnerTexts()).map((t) => t.replace(/\s*\(\d+\)$/, "").trim());
}

/** Buttons inside Admin → Franchise other than the tab buttons. */
async function actionButtons(page: Page): Promise<string[]> {
  const all = (await page.getByTestId("franchise-admin").getByRole("button").allInnerTexts()).map((t) => t.trim());
  return all.filter((t) => !FRANCHISE_TABS.includes(t.replace(/\s*\(\d+\)$/, "")));
}

async function overviewBadges(page: Page) {
  await expect(page.getByText("Booking open", { exact: true })).toBeVisible();
  await expect(page.getByText("Provisional fees not on sale", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Launch: \d+ dealers · \d+ zones · \d+ of 25 places left$/)).toBeVisible();
  await expect(page.getByText(/^Config v\d+$/)).toBeVisible();
}

qa("TC-FRN-044", "Admin → Franchise: the admin opens it from Dealers with every tab and the booking controls; the operator reads the same data with no action buttons and is refused every write; customer and shop owner are sent home and refused; a guest goes to sign-in", async ({ browser }) => {
  // 1. Admin: Dealers → "Franchise (territories)". The controls are looked at, never clicked.
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/dealers");
    await page.getByRole("link", { name: "Franchise (territories)" }).click();
    await expect(page).toHaveURL(/\/admin\/franchise$/);
    expect(await franchiseTabs(page)).toEqual(FRANCHISE_TABS);
    await overviewBadges(page);
    await expect(page.getByRole("button", { name: "Close booking" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create hidden test zone" })).toBeVisible();
  } finally {
    await context.close();
  }

  // 2. Operator: every tab read-only.
  const seen: string[] = [];
  const { context: opsContext, page: opsPage } = await pageAs(browser, "ops");
  try {
    await opsPage.goto("/admin/franchise");
    expect(await franchiseTabs(opsPage)).toEqual(FRANCHISE_TABS);
    await overviewBadges(opsPage);
    for (const tab of FRANCHISE_TABS) {
      await opsPage.getByRole("navigation", { name: "Franchise admin" }).getByRole("button", { name: new RegExp(`^${tab.replace(/[&]/g, "\\$&")}( \\(\\d+\\))?$`) }).click();
      // Areas and Coupons load their data after the click: read their buttons once it is on screen.
      if (tab === "Areas") await expect(opsPage.getByTestId("admin-areas")).toBeVisible({ timeout: 60_000 });
      if (tab === "Coupons") await expect(opsPage.getByTestId("admin-coupons")).toBeVisible({ timeout: 60_000 });
      if (tab === "Zone status") await expect(opsPage.getByText("Read only: only an admin can change a zone's status.")).toBeVisible();
      if (tab === "Fees") await expect(opsPage.getByText("Only an admin imports business data and publishes fees. The current tiers and fees are on the Zones tab.")).toBeVisible();
      if (tab === "Commission & bonus") {
        const inputs = opsPage.getByTestId("admin-bonus-settings").getByRole("textbox");
        expect(await inputs.count(), "commission & bonus inputs").toBeGreaterThan(0);
        for (const input of await inputs.all()) await expect(input).not.toBeEditable();
      }
      const buttons = await actionButtons(opsPage);
      // Areas: "Correct a shop's area" is the operator's by design (decision G-02, "Admin or operator. Logged").
      const allowed = tab === "Areas" ? ["Save"] : [];
      expect(buttons.filter((b) => !allowed.includes(b)), `operator's buttons on ${tab}`).toEqual([]);
      seen.push(tab);
    }
  } finally {
    await opsContext.close();
  }

  // 3. Operator writes: refused. Invalid bodies, so a broken guard could not change the config, a zone or a franchise.
  const ops = await as("ops");
  const overview = await call(ops, "GET", "/api/admin/franchise");
  expectStatus(overview, 200, "operator reads /api/admin/franchise");
  const allocationId: string = overview.body.allocations?.[0]?.id ?? NO_SUCH_ID;
  expectRefusal(await call(ops, "PUT", "/api/admin/franchise/config", {}), 403, NO_ACCESS, "operator PUT franchise/config");
  expectRefusal(await call(ops, "POST", "/api/admin/franchise/zones/status", {}), 403, NO_ACCESS, "operator POST zones/status");
  expectRefusal(await call(ops, "PATCH", `/api/admin/franchise/allocations/${allocationId}`, {}), 403, NO_ACCESS, "operator PATCH allocations/<id>");

  // 4. Customer and shop owner.
  for (const role of ["customer", "shop"] as const) {
    expect(redirectTarget(await getPage(role, "/admin/franchise")), `${role} opens /admin/franchise`).toBe("/");
    expectRefusal(await call(await as(role), "GET", "/api/admin/franchise"), 403, "Franchise administration is for GoKesari staff.", `${role} GET /api/admin/franchise`);
  }

  // 5. Signed out.
  expect(redirectTarget(await getPage("guest", "/admin/franchise")), "guest opens /admin/franchise").toBe("/signin?callbackUrl=/admin/franchise");
  return `admin: 14 tabs, badges, Close booking + Create hidden test zone; operator read ${seen.length} tabs with no action buttons (Areas keeps its operator "Save" by design), PUT config / POST zones/status / PATCH allocation → 403; customer, shop owner → / and API 403; guest → /signin?callbackUrl=/admin/franchise`;
}, { ...signed, timeout: 420_000 });

qa("TC-FRN-055", "refund a franchise booking: an operator is refused (and sees no Refund button), a short reason is 422, an unknown booking is refused; nothing changes", async ({ browser }) => {
  const fourEye = await featureFlag("dealer_platform_four_eye");
  if (fourEye) blocked("dealer_platform_four_eye is ON on staging: an admin's refund call would raise a second-admin request (a write) instead of the answers this check reads");
  const admin = await as("admin");
  const before = await call(admin, "GET", "/api/admin/franchise");
  expectStatus(before, 200, "admin reads the franchises");
  const rows = before.body.allocations as { id: string; status: string; zoneId: string }[];
  const allocations = rows.map((a) => `${a.id}:${a.status}`).sort();
  const refundable = rows.filter((a) => a.status === "ACTIVE" || a.status === "SUSPENDED");

  // 1. Operator: refused, and no Refund button on the Franchises tab. A booking id that exists nowhere: a broken
  //    permission check could not refund a real booking (it would answer 404 and this check fails).
  const ops = await as("ops");
  expectRefusal(await call(ops, "POST", `/api/admin/franchise/bookings/${NO_SUCH_ID}/refund`, { reason: "QA refund test" }), 403, "You may not refund franchise bookings.", "operator refund");
  let buttons = "no running franchise on staging, so no Refund button for anyone";
  for (const role of refundable.length ? (["admin", "ops"] as const) : (["ops"] as const)) {
    const { context, page } = await pageAs(browser, role);
    try {
      await page.goto("/admin/franchise?tab=franchises");
      await expect(page.getByRole("navigation", { name: "Franchise admin" })).toBeVisible({ timeout: 60_000 });
      if (refundable.length) await expect(page.getByRole("cell", { name: refundable[0].zoneId }).first(), `${role}: the Franchises tab lists ${refundable[0].zoneId}`).toBeVisible();
      // The admin's button is only looked at, never clicked.
      if (role === "admin") await expect(page.getByRole("button", { name: "Refund booking" }).first(), "admin sees Refund booking").toBeVisible();
      else await expect(page.getByRole("button", { name: "Refund booking" }), "operator sees no Refund booking").toHaveCount(0);
    } finally {
      await context.close();
    }
  }
  if (refundable.length) buttons = `Refund booking shown to the admin on ${refundable[0].zoneId}, not to the operator`;

  // 2. Admin, reason "abc": 422 before anything is looked up.
  const short = await call(admin, "POST", `/api/admin/franchise/bookings/${NO_SUCH_ID}/refund`, { reason: "abc" });
  expect(short.status, `admin refund with reason "abc" — ${why(short)}`).toBe(422);

  // 3. A booking that is not paid: staging has no RESERVED booking, so an unknown one is sent.
  const unknown = await call(admin, "POST", `/api/admin/franchise/bookings/${NO_SUCH_ID}/refund`, { reason: "QA refund test" });
  expectRefusal(unknown, 404, "Booking was not found.", "admin refund of an unknown booking");

  const after = await call(admin, "GET", "/api/admin/franchise");
  expect((after.body.allocations as { id: string; status: string }[]).map((a) => `${a.id}:${a.status}`).sort(), "franchises after the refused refunds").toEqual(allocations);
  return `dealer_platform_four_eye off; operator → 403 "You may not refund franchise bookings."; ${buttons}; reason "abc" → 422; unknown booking → 404 "Booking was not found."; franchises unchanged (${allocations.length})`;
}, {
  ...signed,
  partial:
    "steps 3–5 on real bookings are not run: staging has no RESERVED booking (409 “Only a paid booking can be refunded.”) and no paid QA booking that may be refunded (the 200 refund and the second 409); the four-eye 202 path needs the flag on",
});

/* ===================================================== referral code moves */

const SELF_DECISION = "A different admin must approve or reject this request.";
const MOVE_TAG = "QA TC-REFM-015 self-approval check";

/** Test shops a move request may name: an E2E shop with no referral team, then shop B. */
const MOVE_SHOP_CANDIDATES = [{ id: "9bbea75f-6e76-4ca5-87dc-db14aa35f71b", name: "E2E Referral MV2SEV7D-1" }];

interface MoveRequest {
  id: string;
  status: string;
  requestedBy: string;
  reason: string;
  shopIds: string[];
  missing: { kind: string; shopId: string | null; label: string }[];
  documents: { id: string; kind: string }[];
}

async function moveRequest(id: string): Promise<MoveRequest> {
  const res = await call(await as("admin"), "GET", "/api/admin/referral-moves");
  expectStatus(res, 200, "admin lists the referral moves");
  return need((res.body.requests as MoveRequest[]).find((r) => r.id === id), `the move request ${id}`);
}

/** A test shop for the request: the first candidate still with no team, else shop B. */
async function moveShop(): Promise<{ id: string; name: string; dealerName: string | null }> {
  const admin = await as("admin");
  const candidates = [...MOVE_SHOP_CANDIDATES, ...(world().shops.B?.id ? [{ id: world().shops.B!.id!, name: world().shops.B!.name }] : [])];
  for (const c of candidates) {
    const res = await call(admin, "GET", `/api/admin/referral-moves/shops?q=${c.id}`);
    expectStatus(res, 200, "search a shop for a move");
    const hit = (res.body.shops as { id: string; name: string; dealerName: string | null }[]).find((s) => s.id === c.id && s.name === c.name);
    if (hit && (hit.dealerName === null || c === candidates[candidates.length - 1])) return hit;
  }
  blocked("no E2E test shop or shop B found for a referral-move request");
}

qa("TC-REFM-015", "the admin who raised a referral-move request sees only Cancel on its card, and the API refuses that admin's own approve and reject with 403; the request stays pending (then cancelled)", async ({ browser }) => {
  const admin = await as("admin");
  const adminId = (await me("admin")).id;
  const dealers = await call(admin, "GET", "/api/admin/dealers?status=APPROVED");
  expectStatus(dealers, 200, "approved dealers");
  const toDealer = need((dealers.body.dealers as { id: string; legalName: string; isInternal: boolean }[]).find((d) => d.legalName === "QA Staging Test Dealer" && !d.isInternal), "the approved test dealer “QA Staging Test Dealer”");
  const shop = await moveShop();

  // An earlier run's own request on this shop, left waiting: cancel it first.
  const waiting = await call(admin, "GET", "/api/admin/referral-moves?status=PENDING");
  expectStatus(waiting, 200, "waiting requests");
  for (const r of waiting.body.requests as MoveRequest[]) {
    if (r.requestedBy === adminId && r.shopIds.includes(shop.id) && r.reason.startsWith(MOVE_TAG)) {
      expectStatus(await call(admin, "POST", `/api/admin/referral-moves/${r.id}`, { action: "cancel", note: "QA cleanup of an earlier run" }), 200, "cancel an earlier run's request");
    }
  }

  let requestId: string | null = null;
  let failure: unknown = null;
  const notes: string[] = [];
  try {
    const created = await call(admin, "POST", "/api/admin/referral-moves", { kind: "SHOPS", shopIds: [shop.id], toDealerId: toDealer.id, toMemberId: null, reason: `${MOVE_TAG} ${RUN} — cancelled at once, never approved` });
    expectStatus(created, 201, "raise the move request");
    requestId = String(created.body.id);
    const reason = String(created.body.reason);

    // Before any letter is in: a broken guard would stop at the missing letters (409), never move the shop.
    expectRefusal(await call(admin, "POST", `/api/admin/referral-moves/${requestId}`, { action: "approve", note: "self approve" }), 403, SELF_DECISION, "self approve before the letters");

    // The consent letters the request needs (dummy PDFs).
    let lettersIn = true;
    for (const m of (await moveRequest(requestId)).missing) {
      const up = await call(admin, "POST", `/api/admin/referral-moves/${requestId}/documents`, undefined, {
        multipart: { file: { name: `qa-dummy-${m.kind.toLowerCase()}.pdf`, mimeType: "application/pdf", buffer: DUMMY_PDF }, kind: m.kind, ...(m.shopId ? { shopId: m.shopId } : {}) },
      });
      if (up.status === 409 && /not available on this site/.test(up.body?.error?.message ?? "")) {
        lettersIn = false;
        notes.push(`letters not uploaded: ${why(up)}`);
        break;
      }
      expectStatus(up, 201, `upload ${m.label}`);
    }
    const ready = await moveRequest(requestId);
    if (lettersIn) expect(ready.missing, "letters still missing").toEqual([]);
    notes.push(`${ready.documents.length} dummy letter(s) uploaded`);

    // 1. The card as the admin who raised it.
    const { context, page } = await pageAs(browser, "admin");
    try {
      await page.goto("/admin/dealers/referral-moves");
      const card = page.getByTestId("referral-move-request").filter({ hasText: reason });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText("You raised this request — a different admin approves or rejects it.");
      await expect(card.getByLabel("Note (to cancel your request)")).toBeVisible();
      await expect(card.getByRole("button", { name: "Cancel request" })).toBeVisible();
      await expect(card.getByRole("button", { name: "Approve and move" })).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Reject" })).toHaveCount(0);
      if (lettersIn) await expect(card).toContainText("All consent letters are in.");
    } finally {
      await context.close();
    }

    // 2–3. The API: the admin's own approve and reject.
    expectRefusal(await call(admin, "POST", `/api/admin/referral-moves/${requestId}`, { action: "approve", note: "self approve" }), 403, SELF_DECISION, "self approve");
    expectRefusal(await call(admin, "POST", `/api/admin/referral-moves/${requestId}`, { action: "reject", note: "self reject" }), 403, SELF_DECISION, "self reject");
    expect((await moveRequest(requestId)).status, "the request after the refused decisions").toBe("PENDING");
  } catch (error) {
    failure = error;
  } finally {
    if (requestId) {
      const cancel = await call(admin, "POST", `/api/admin/referral-moves/${requestId}`, { action: "cancel", note: "QA cleanup: cancelling my own test request" });
      const settled = cancel.status === 200 || (cancel.status === 409 && /Only a waiting request/.test(cancel.body?.error?.message ?? ""));
      if (!settled && !failure) failure = new Error(`could not cancel the test move request ${requestId} — ${why(cancel)}`);
      notes.push(cancel.status === 200 ? `request ${requestId.slice(0, 8)} cancelled` : `cancel → ${why(cancel)}`);
    }
  }
  if (failure) throw failure;
  return `${shop.name} → ${toDealer.legalName}: card shows only "Cancel request" with the note field; own approve (before and after the letters) and reject → 403 "${SELF_DECISION}"; still pending; ${notes.join("; ")}`;
}, { ...signed, partial: "step 4 (the database check referral_move_requests_decider) needs the database (developer)" });

qa("TC-REFM-002", "only an admin opens Referral moves or calls its APIs: guest to sign-in and 401, customer and operator sent home, every operator call 403 and nothing created or decided", async ({ browser }) => {
  if ((await featureFlag("dealer_programme_enabled")) !== true) blocked("dealer_programme_enabled is off on this site");
  const admin = await as("admin");
  const listBefore = await call(admin, "GET", "/api/admin/referral-moves");
  expectStatus(listBefore, 200, "admin lists the referral moves");
  const before = (listBefore.body.requests as MoveRequest[]).map((r) => `${r.id}:${r.status}:${r.documents.length}`).sort();
  // REQ: a request that is no longer waiting (a broken guard could then decide nothing), else an id that exists nowhere.
  const req = (listBefore.body.requests as MoveRequest[]).find((r) => r.status !== "PENDING")?.id ?? NO_SUCH_ID;

  // 1–2. Signed out.
  expect(redirectTarget(await getPage("guest", "/admin/dealers/referral-moves")), "guest opens Referral moves").toBe("/signin");
  const guest = await anonymous();
  try {
    expectRefusal(await call(guest, "GET", "/api/admin/referral-moves"), 401, SIGN_IN, "guest GET referral-moves");
  } finally {
    await guest.dispose();
  }

  // 3. Customer and operator: sent to the home page.
  for (const role of ["customer", "ops"] as const) {
    expect(redirectTarget(await getPage(role, "/admin/dealers/referral-moves")), `${role} opens Referral moves`).toBe("/");
    const { context, page } = await pageAs(browser, role);
    try {
      expect(await landing(page, "/admin/dealers/referral-moves"), `${role} ends on`).toBe("/");
      await expect(page.getByRole("heading", { name: "Referral moves" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  }

  // 4. Operator calls.
  const ops = await as("ops");
  expectRefusal(await call(ops, "GET", "/api/admin/referral-moves"), 403, NO_ACCESS, "operator GET referral-moves");
  expectRefusal(await call(ops, "GET", "/api/admin/referral-moves/shops?q=te"), 403, NO_ACCESS, "operator GET referral-moves/shops");
  expectRefusal(await call(ops, "POST", `/api/admin/referral-moves/${req}`, { action: "approve", note: "operator try" }), 403, NO_ACCESS, "operator approves");
  const doc = await call(ops, "POST", `/api/admin/referral-moves/${req}/documents`, undefined, {
    multipart: { file: { name: "qa-dummy.pdf", mimeType: "application/pdf", buffer: DUMMY_PDF }, kind: "OTHER" },
  });
  expectRefusal(doc, 403, NO_ACCESS, "operator uploads a document");

  const listAfter = await call(admin, "GET", "/api/admin/referral-moves");
  expect((listAfter.body.requests as MoveRequest[]).map((r) => `${r.id}:${r.status}:${r.documents.length}`).sort(), "requests after the operator's calls").toEqual(before);
  return `guest → /signin and API 401; customer, operator → /; operator GET list / shops, POST approve and document → 403 "${NO_ACCESS}" (REQ ${req === NO_SUCH_ID ? "an id that exists nowhere" : `${req.slice(0, 8)}, not waiting`}); nothing created or decided`;
}, signed);

/* ===================================================== dealership platform */

interface SchemeTerms {
  components: { id: string; label: string; kind: string; basis: string; formula?: string }[];
  [key: string]: unknown;
}
interface SchemeVersion {
  id: string;
  version: number;
  status: string;
  label: string | null;
  terms: SchemeTerms;
}
interface Scheme {
  id: string;
  code: string;
  name: string;
  status: string;
  versions: SchemeVersion[];
}

async function schemes(): Promise<Scheme[]> {
  const res = await call(await as("admin"), "GET", "/api/admin/dealer-schemes");
  expectStatus(res, 200, "admin lists the dealer schemes");
  return res.body.schemes as Scheme[];
}

/** The text of a term (Joining charge, Validity, …) in a version's terms panel. */
function term(panel: Locator, label: string): Locator {
  return panel.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
}

async function expectTerms(panel: Locator, terms: Record<string, string>, commission: string[]) {
  for (const [label, value] of Object.entries(terms)) await expect(term(panel, label), label).toHaveText(value);
  const lines = (await panel.getByRole("listitem").allInnerTexts()).map((t) => t.trim());
  for (const line of commission) expect(lines, `commission line “${line}”`).toContain(line);
}

qa("TC-DPLT-002", "the published scheme terms read as the owner's decisions D1–D3, D7: Free v2, Business Partner, Growth Partner, Territory Franchise, and Free v1", async ({ browser }) => {
  const list = await schemes();
  const published = (code: string) => {
    const scheme = need(list.find((s) => s.code === code), `the ${code} scheme`);
    return need(scheme.versions.find((v) => v.status === "PUBLISHED"), `a published version of ${code}`);
  };
  expect(published("FREE").version, "Free Dealership's published version").toBe(2);
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/dealers/schemes");
    await expect(page.getByRole("heading", { name: "Dealership & franchise schemes" })).toBeVisible();
    const panel = (code: string, version: number) => page.getByTestId(`scheme-${code}-v${version}`);

    await expectTerms(
      panel("FREE", 2),
      { "Joining charge": "Free", Validity: "12 months, renewable", Where: "All India · Not exclusive", "Team building": "No", Calculation: "Calculated from these terms" },
      ["One-time: 20% of shop registration fee", "Recurring: 5% of GoKesari's commission, monthly, 12 months"],
    );
    await expectTerms(
      panel("BUSINESS_PARTNER", published("BUSINESS_PARTNER").version),
      { "Joining charge": "₹11,000 + 18% GST = ₹12,980" },
      ["One-time: 25% of shop registration fee", "Recurring: 15% of GoKesari's commission, monthly, 12 months"],
    );
    await expectTerms(
      panel("GROWTH_PARTNER", published("GROWTH_PARTNER").version),
      { "Joining charge": "₹21,000 + 18% GST = ₹24,780", "Team building": "Yes" },
      [
        "One-time: 30% of shop registration fee",
        "Recurring: 25% of GoKesari's commission, monthly, 12 months",
        "Team commission (level 1): 4% of shop registration fee",
        "Team commission (level 2): 3% of shop registration fee",
      ],
    );
    await expectTerms(
      panel("TERRITORY_FRANCHISE", published("TERRITORY_FRANCHISE").version),
      { "Joining charge": "₹1,50,000 + 18% GST = ₹1,77,000", Where: "Booked franchise zone · Shared · up to 2 per territory", Calculation: "Calculated by Franchise settings (existing)" },
      ["Performance bonus: up to 5% of GoKesari's commission, monthly"],
    );

    // Free Dealership version 1 (superseded): open it and read it.
    await page.getByTestId("scheme-FREE").getByText("Version 1", { exact: true }).click();
    await expect(panel("FREE", 1)).toBeVisible();
    await expectTerms(panel("FREE", 1), { Validity: "No end date", Calculation: "Calculated by Dealer commission (existing)" }, ["One-time: rate set in Dealer commission"]);
  } finally {
    await context.close();
  }
  return "Free v2, Business Partner v1, Growth Partner v1, Territory Franchise v1 and Free v1 read as the case's Expected result";
}, signed);

const DRAFT_LABEL = "QA draft 23-Nov — delete";
const VALID_FORMULA = "IF(shopsThisMonth >= 50, PERCENT(platformCommissionPaise, 700), PERCENT(platformCommissionPaise, 500))";
const BAD_FORMULAS: [string, string][] = [
  ["constructor + 1", "The name 'constructor' is not allowed (position 0)."],
  ["eval(1)", "Unknown function 'eval' at position 0."],
  ["foo * 2", "Unknown variable 'foo' at position 0."],
  ["shopsThisMonth > 5 && activeShops > 2", "Use 'and' instead of '&&' at position 19."],
];

async function deleteDraft(schemeId: string, versionId: string) {
  return call(await as("admin"), "POST", `/api/admin/dealer-schemes/${schemeId}`, { action: "deleteDraft", versionId, reason: "QA cleanup: delete the formula-check draft" });
}

qa("TC-DPLT-038", "scheme builder formulas: a valid formula is accepted and the draft saves; constructor, eval, an unknown variable and && are named with their position and block Save; the API refuses the bad formula with 422", async ({ browser }) => {
  // A dealership scheme with no draft (one draft per scheme); an earlier run's QA draft is deleted first.
  let list = await schemes();
  for (const s of list) for (const v of s.versions) if (v.status === "DRAFT" && v.label === DRAFT_LABEL) expectStatus(await deleteDraft(s.id, v.id), 200, "delete an earlier run's QA draft");
  list = await schemes();
  const scheme = need(
    ["BUSINESS_PARTNER", "GROWTH_PARTNER", "FREE"].map((code) => list.find((s) => s.code === code && s.status === "PUBLISHED" && !s.versions.some((v) => v.status === "DRAFT"))).find(Boolean),
    "a published dealership scheme without a draft",
  );
  const base = need(scheme.versions.find((v) => v.status === "PUBLISHED"), `${scheme.code}'s published version`);
  const index = base.terms.components.findIndex((c) => c.kind === "RECURRING");
  if (index < 0) blocked(`${scheme.code} has no recurring commission to base a formula on`);
  const component = base.terms.components[index];

  let draftId: string | null = null;
  let failure: unknown = null;
  const seen: string[] = [];
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto(`/admin/dealers/schemes/${scheme.id}`);
    const editor = page.getByTestId("scheme-editor");
    await expect(editor.getByRole("heading", { name: `New version (from v${base.version})` })).toBeVisible();
    await editor.getByLabel("Version label").fill(DRAFT_LABEL);
    const row = page.getByTestId(`component-${index}`);
    await row.getByLabel("Based on").selectOption("FORMULA");
    const formula = row.getByLabel("Formula (result in paise)");
    const help = editor.locator("details").filter({ hasText: "Formula help" });
    const helpLine = help.getByText(new RegExp(`^${component.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));

    // 1. The valid formula, Formula help, and the draft saves.
    await formula.fill(VALID_FORMULA);
    await help.getByText("Formula help").click();
    await expect(helpLine, "Formula help is open").toBeVisible();
    await expect(helpLine).toHaveText(`${component.label}: formula is valid`);
    await expect(editor.getByText("Not complete yet")).toHaveCount(0);
    await editor.getByLabel("Reason for this change (kept in the audit log)").fill("QA formula check 23-Nov (draft deleted after the check)");
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/admin/dealer-schemes/${scheme.id}`) && r.request().method() === "POST");
    await editor.getByRole("button", { name: "Save as new version" }).click();
    const res = await saved;
    const body = (await res.json().catch(() => null)) as { version?: { id: string; status: string; version: number }; error?: { message?: string } } | null;
    expect(res.status(), `save the draft — ${body?.error?.message ?? ""}`).toBe(200);
    draftId = need(body?.version?.id, "the saved draft's id");
    expect(body?.version?.status).toBe("DRAFT");
    await expect(page.getByText("New draft version saved.")).toBeVisible();
    await expect(editor.getByRole("heading", { name: `Edit draft v${body?.version?.version}` })).toBeVisible();
    seen.push("valid → formula is valid, draft saved");

    // 2–5. Each bad formula: named in Formula help and in "Not complete yet", and Save draft is disabled.
    for (const [text, message] of BAD_FORMULAS) {
      await formula.fill(text);
      await expect(helpLine, text).toHaveText(`${component.label}: ${message}`);
      const incomplete = editor.getByRole("status").filter({ hasText: "Not complete yet" });
      await expect(incomplete, text).toBeVisible();
      await expect(incomplete, text).toContainText(message);
      await expect(editor.getByRole("button", { name: "Save draft" }), text).toBeDisabled();
      seen.push(`${text} → ${message}`);
    }

    // 6. The API with foo * 2.
    const terms = structuredClone(base.terms);
    terms.components[index] = { ...terms.components[index], basis: "FORMULA", formula: "foo * 2" };
    const refused = await call(await as("admin"), "POST", `/api/admin/dealer-schemes/${scheme.id}`, { action: "saveDraft", versionId: draftId, terms, label: DRAFT_LABEL, reason: "QA formula check: bad formula" });
    expectRefusal(refused, 422, "The terms are not complete: Unknown variable 'foo' at position 0.", "saveDraft with foo * 2");
    seen.push("API foo * 2 → 422");
  } catch (error) {
    failure = error;
  } finally {
    await context.close();
    if (draftId) {
      const deleted = await deleteDraft(scheme.id, draftId);
      if (deleted.status !== 200 && !failure) failure = new Error(`could not delete the QA draft ${draftId} of ${scheme.code} — ${why(deleted)}`);
      seen.push(deleted.status === 200 ? "draft deleted" : `delete → ${why(deleted)}`);
    }
  }
  if (failure) throw failure;
  const left = (await schemes()).find((s) => s.id === scheme.id)?.versions.filter((v) => v.status === "DRAFT") ?? [];
  expect(left, `${scheme.code} drafts after the cleanup`).toEqual([]);
  return `${scheme.name} (${component.label}): ${seen.join("; ")}`;
}, { ...signed, timeout: 360_000 });
