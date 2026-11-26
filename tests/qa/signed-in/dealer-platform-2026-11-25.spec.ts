/**
 * Dealership platform (TC-DPLT-…, PR #503): the cases of the 23-Nov-2026 plan that were declared manual and can run
 * on test.gokesari.com with the existing test accounts (25-Nov-2026).
 *
 * What these checks may do on staging:
 *   - read the admin scheme, dashboard and dealer pages and APIs, the dealer application and the simulator (which
 *     works out its figures in the page);
 *   - send writes the server must REFUSE. Every refused body fails the route's schema or a check that runs before
 *     the database write (scheme-admin.ts, scheme-change.ts; dealer_platform_four_eye is off on staging, so a write
 *     that got through would apply at once — each check reads the schemes again afterwards).
 * Nothing creates, publishes, suspends or edits a scheme, moves a dealer, pays a joining charge or saves an
 * application. The rest of each case (new dealers, payments, month close, role grants, a second approver) stays
 * manual — see `partial`. The terms asserted are those staging serves today (Free Dealership v2 with 20% one-time
 * and 5% monthly); the owner's D1–D10 answers (PR #546, Free v3) change them when that PR lands.
 */
import type { Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { anonymous, call, expectStatus, type Answer } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";

const signed = { tier: "signed" as const, timeout: 300_000 };
const NO_ACCESS_DO = "You do not have access to do that.";
const SIGN_IN = "Please sign in to continue.";
const message = (res: Answer) => String(res.body?.error?.message ?? "");

interface Version {
  id: string;
  version: number;
  status: string;
  label: string;
  termsHash: string;
  terms: { charge?: { amountPaise?: number } };
}
interface Scheme {
  id: string;
  code: string;
  name: string;
  category: string;
  status: string;
  versions: Version[];
}

async function schemes(): Promise<Scheme[]> {
  const res = await call(await as("admin"), "GET", "/api/admin/dealer-schemes");
  expectStatus(res, 200, "admin reads the schemes");
  return res.body.schemes as Scheme[];
}
const byCode = (list: Scheme[], code: string) => need(list.find((s) => s.code === code), `scheme ${code}`);
/** What could change if a refused write got through: each scheme's status and versions. */
const fingerprint = (list: Scheme[]) => JSON.stringify(list.map((s) => [s.code, s.status, s.versions.map((v) => [v.id, v.status, v.termsHash])]));

async function guestCall(method: "GET" | "POST", path: string): Promise<Answer> {
  const ctx = await anonymous();
  try {
    return await call(ctx, method, path);
  } finally {
    await ctx.dispose();
  }
}

async function mainText(page: Page) {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

async function expectNoSideScroll(page: Page, what: string) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll, `${what}: page is ${scroll}px wide in a ${width}px viewport (sideways scroll)`).toBeLessThanOrEqual(width + 1);
}

const PHONE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };

/* ================================================================== schemes (admin) */

qa("TC-DPLT-001", "Admin → Dealers → Schemes: title, the create card, the four schemes in order with dealer counts, Free Dealership v2 published and v1 superseded, each version with its reason and terms fingerprint", async ({ browser }) => {
  const list = await schemes();
  // Owner's D1–D10 answers of 25-Nov-2026 (migration 0207 / 0190): Free Dealership v3 published (v2 without the 5%
  // monthly), Business Partner and Growth Partner SUSPENDED (no new applicants; an admin can publish them again).
  if (byCode(list, "BUSINESS_PARTNER").status === "ARCHIVED") {
    blocked(
      "Business Partner is ARCHIVED on this site (an earlier run of TC-DPLT-031 sent its archive refusal to the suspended scheme, which accepted it; " +
        "fixed in the check on 27-Nov-2026). Reset: dealer_schemes BUSINESS_PARTNER back to SUSPENDED (database; an archived scheme cannot be reopened from the screen)",
    );
  }
  expect(list.map((s) => `${s.code} ${s.status} ${s.category}`)).toEqual(["FREE PUBLISHED DEALERSHIP", "BUSINESS_PARTNER SUSPENDED DEALERSHIP", "GROWTH_PARTNER SUSPENDED DEALERSHIP", "TERRITORY_FRANCHISE PUBLISHED FRANCHISE"]);
  const free = byCode(list, "FREE").versions.map((v) => `${v.version} ${v.status} ${v.label}`);
  expect(free).toEqual(["3 PUBLISHED Owner 25-Nov-2026: 20% one-time only", "2 SUPERSEDED Brief 23-Nov-2026", "1 SUPERSEDED Terms before 23-Nov-2026"]);

  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/dealers");
    await page.getByRole("link", { name: "Schemes", exact: true }).first().click({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/admin\/dealers\/schemes$/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Dealership & franchise schemes" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Create a new scheme").first()).toBeVisible();
    // Step 3: expand each scheme's versions (older versions are folded).
    const folded = page.locator("main details:not([open]) > summary");
    for (let n = await folded.count(); n > 0; n = await folded.count()) await folded.first().click();
    const text = await mainText(page);
    let at = -1;
    for (const name of ["Free Dealership published dealership", "Business Partner suspended dealership", "Growth Partner suspended dealership", "Territory Franchise published franchise"]) {
      const i = text.indexOf(name);
      expect(i, `“${name}” after the one before it`).toBeGreaterThan(at);
      at = i;
    }
    expect(text).toMatch(/Free Dealership published dealership \d+ dealers?/);
    expect(text).toMatch(/Version 3 published Owner 25-Nov-2026: 20% one-time only/);
    expect(text).toMatch(/Version 2 superseded Brief 23-Nov-2026/);
    expect(text).toMatch(/Version 1 superseded Terms before 23-Nov-2026 · \d+ dealers?/);
    const why = (text.match(/Why: /g) ?? []).length;
    const prints = text.match(/Terms fingerprint [0-9a-f]{16}\b/g) ?? [];
    const versions = list.reduce((n, s) => n + s.versions.length, 0);
    expect(prints.length, "one terms fingerprint per version").toBe(versions);
    expect(why, "one reason per version").toBe(versions);
    return `four schemes in order (Business / Growth Partner suspended, D2); Free v3 published / v2, v1 superseded (D1); ${versions} versions each with “Why:” and a 16-hex fingerprint`;
  } finally {
    await context.close();
  }
}, signed);

qa("TC-DPLT-029", "creating a scheme is refused for a code that exists, a bad code, a short reason and a short name; no scheme is added", async () => {
  const admin = await as("admin");
  const before = await schemes();
  const tries: [string, Record<string, unknown>, number, string][] = [
    ["code FREE", { code: "FREE", name: "Free again", category: "DEALERSHIP", reason: "dup test" }, 409, "A scheme with code FREE already exists."],
    ["code 1ABC", { code: "1ABC", name: "QA refused", category: "DEALERSHIP", reason: "QA refused write" }, 422, "A code of 2–40 capital letters, digits and _ starting with a letter (e.g. SILVER_PARTNER)."],
    ["reason ok", { code: "QA_REFUSED", name: "QA refused", category: "DEALERSHIP", reason: "ok" }, 422, "Give a reason (at least 5 characters); it is kept in the audit log."],
    ["name ab", { code: "QA_REFUSED", name: "ab", category: "DEALERSHIP", reason: "QA refused write" }, 422, "Please check the highlighted fields."],
  ];
  const seen: string[] = [];
  for (const [what, body, status, text] of tries) {
    const res = await call(admin, "POST", "/api/admin/dealer-schemes", body);
    expectStatus(res, status, what);
    expect(message(res), what).toBe(text);
    seen.push(`${what} ${res.status}`);
  }
  expect(fingerprint(await schemes()), "schemes unchanged").toBe(fingerprint(before));
  return `${seen.join("; ")}; no scheme added`;
}, { ...signed, partial: "Cloning Business Partner into a new scheme (step 5) would add a scheme on staging, so it is not done" });

qa(["TC-DPLT-031", "TC-DPLT-033", "TC-DPLT-035"], "scheme writes that must be refused are refused: incomplete terms 422, deleting a published version 409, archiving a published scheme 409, expiring Free Dealership 409; nothing changes", async () => {
  const admin = await as("admin");
  const before = await schemes();
  const free = byCode(before, "FREE");
  // The archive refusal needs a PUBLISHED scheme other than Free Dealership. Business Partner is SUSPENDED since the
  // owner's D2 (25-Nov-2026), and a suspended scheme MAY be archived — sending it there archived staging's Business
  // Partner (baseline 27-Nov-2026). Only a scheme whose status is PUBLISHED right now is used.
  const target = need(before.find((s) => s.code !== "FREE" && s.status === "PUBLISHED"), "a published scheme other than Free Dealership");
  const published = need(free.versions.find((v) => v.status === "PUBLISHED"), "Free Dealership's published version");
  const bad = { summary: "QA refused terms", calculation: "SCHEME", charge: { kind: "ONE_TIME", amountPaise: 0, gstRateBp: 1800, gstMode: "EXCLUSIVE", refundable: false }, components: [] };
  const tries: [string, string, Record<string, unknown>, number, RegExp][] = [
    ["saveDraft with incomplete terms", free.id, { action: "saveDraft", terms: bad, reason: "QA refused write" }, 422, /^The terms are not complete: /],
    ["deleteDraft of the published version", free.id, { action: "deleteDraft", versionId: published.id, reason: "QA refused write" }, 409, /^Only a draft can be deleted\.$/],
    [`${target.name} → ARCHIVED`, target.id, { action: "status", to: "ARCHIVED", reason: "QA refused write" }, 409, /^A published scheme cannot become archived\.$/],
    ["Free Dealership → EXPIRED", free.id, { action: "status", to: "EXPIRED", reason: "QA refused write" }, 409, /^Free Dealership is the default for new dealers and cannot be expired or archived\. Suspend it instead\.$/],
  ];
  const seen: string[] = [];
  for (const [what, id, body, status, text] of tries) {
    const res = await call(admin, "POST", `/api/admin/dealer-schemes/${id}`, body);
    expectStatus(res, status, what);
    expect(message(res), what).toMatch(text);
    seen.push(`${what} ${res.status} (${message(res)})`);
  }
  expect(fingerprint(await schemes()), "schemes unchanged").toBe(fingerprint(before));
  return `${seen.join("; ")}; schemes unchanged`;
}, {
  ...signed,
  partial: "Only the refusals are sent: the builder's “Not complete yet” messages, saving / deleting a draft, suspend / reopen / expire / archive of a test scheme would change staging's schemes",
});

qa("TC-DPLT-036", "compare two versions: Free v1 with v2 lists the changed fields; v2 with itself has none; the operator gets the same answer", async ({ browser }) => {
  const free = byCode(await schemes(), "FREE");
  const v1 = need(free.versions.find((v) => v.version === 1), "Free v1");
  const v2 = need(free.versions.find((v) => v.version === 2), "Free v2");
  const compare = async (role: "admin" | "ops", a: string, b: string) => {
    const res = await call(await as(role), "POST", `/api/admin/dealer-schemes/${free.id}`, { action: "compare", a, b });
    expectStatus(res, 200, `${role} compares`);
    return res.body;
  };
  const diff = await compare("admin", v1.id, v2.id);
  const rows = JSON.stringify(diff);
  for (const field of ["calculation", "validityMonths", "teamBuilding"]) expect(rows, `the diff names ${field}`).toContain(field);
  expect(rows).toContain("LEGACY_DEALER");
  const same = await compare("admin", v2.id, v2.id);
  const sameRows = (same.changes ?? same.rows ?? same.diff ?? []) as unknown[];
  expect(sameRows.length, "v2 with v2: no changed field").toBe(0);
  expect(JSON.stringify(await compare("ops", v1.id, v2.id)), "operator: same diff").toBe(rows);

  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto(`/admin/dealers/schemes/${free.id}`);
    await page.getByRole("button", { name: "Compare versions" }).click({ timeout: 60_000 });
    await expect(page.getByRole("columnheader", { name: "Field" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("columnheader", { name: "Before" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "After" })).toBeVisible();
    await expect(page.getByText("New version (from v2)"), "the operator has no editor").toHaveCount(0);
  } finally {
    await context.close();
  }
  return "v1→v2 changes calculation LEGACY_DEALER→SCHEME, validityMonths, teamBuilding; v2 with v2 none; operator sees the same table and no editor";
}, signed);

qa("TC-DPLT-037", "the simulator on Free Dealership v2 with its default assumptions gives the designed figures, and every figure is ₹0 with 0 dealers", async ({ browser }) => {
  const free = byCode(await schemes(), "FREE");
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto(`/admin/dealers/schemes/${free.id}`);
    await expect(page.getByRole("heading", { name: "Simulator" })).toBeVisible({ timeout: 60_000 });
    const sim = page.locator("section, div").filter({ has: page.getByRole("heading", { name: "Simulator" }) }).last();
    const text = (await sim.innerText()).replace(/\s+/g, " ");
    for (const [label, value] of [
      ["Shop registration fees", "₹4,80,000"],
      ["GoKesari commission on sales", "₹31,20,000"],
      ["Dealer one-time commission", "₹96,000"],
      // Free Dealership v3 (owner D1, 25-Nov-2026): no 5% monthly commission.
      ["Dealer monthly commission", "₹0"],
      ["Total dealer payout (liability)", "₹96,000"],
      ["GoKesari net revenue before other costs", "₹35,04,000"],
    ]) {
      expect(text, `${label} ${value}`).toMatch(new RegExp(`${label.replace(/[()]/g, "\\$&")}[^₹]*${value.replace(/[₹,]/g, "\\$&")}`));
    }
    expect(text).toContain("₹15,60,00,000");
    expect(text).toContain("First 12 months: revenue ₹36,00,000, dealer payout ₹96,000, net ₹35,04,000. Last month: 480 active shops, net ₹5,12,000 a month.");
    await sim.getByLabel("Dealers", { exact: true }).fill("0");
    await expect(sim).toContainText("First 12 months: revenue ₹0, dealer payout ₹0, net ₹0.");
    return "Free v3 defaults: fees ₹4,80,000, GMV ₹15,60,00,000, commission ₹31,20,000, monthly ₹0, payout ₹96,000, net ₹35,04,000; 0 dealers → ₹0";
  } finally {
    await context.close();
  }
}, { ...signed, partial: "Business Partner's ₹1,10,000 joining charges with the same inputs are not compared" });

qa("TC-DPLT-039", "the schemes list and a scheme's builder at 375 px: no sideways scroll; the compare button and the simulator are on screen", async ({ browser }) => {
  const free = byCode(await schemes(), "FREE");
  const { context, page } = await pageAs(browser, "admin", PHONE);
  try {
    await page.goto("/admin/dealers/schemes");
    await expect(page.getByRole("heading", { name: "Dealership & franchise schemes" })).toBeVisible({ timeout: 60_000 });
    await expectNoSideScroll(page, "/admin/dealers/schemes");
    await page.goto(`/admin/dealers/schemes/${free.id}`);
    await expect(page.getByRole("heading", { name: "Simulator" })).toBeVisible({ timeout: 60_000 });
    await expectNoSideScroll(page, "scheme builder");
    const compare = page.getByRole("button", { name: "Compare versions" });
    await compare.scrollIntoViewIfNeeded();
    const box = need(await compare.boundingBox(), "the Compare versions button");
    expect(box.x + box.width, "Compare versions inside the screen").toBeLessThanOrEqual(376);
    await compare.click();
    await expect(page.getByRole("columnheader", { name: "Field" })).toBeVisible({ timeout: 30_000 });
    await expectNoSideScroll(page, "with the compare table open");
    await page.getByRole("heading", { name: "Simulator" }).scrollIntoViewIfNeeded();
    await expectNoSideScroll(page, "at the simulator");
    return "375 px: list, builder, compare table and simulator without sideways scroll";
  } finally {
    await context.close();
  }
}, { ...signed, partial: "Button heights (44 px) are not measured one by one; the editor is not edited" });

/* ================================================================== dealer application and change (applicant side) */

qa(["TC-DPLT-007", "TC-DPLT-012"], "the application shows the schemes to compare (no franchise card, a Book a franchise zone link, no Choose before the first save) and fits a phone", async ({ browser }) => {
  const offered = await call(await as("customer"), "GET", "/api/dealer/application/scheme");
  expectStatus(offered, 200, "schemes offered to the customer");
  const codes = (offered.body.schemes as { code: string }[]).map((s) => s.code);
  expect(codes).toEqual(expect.arrayContaining(["FREE"]));
  expect(codes).not.toContain("TERRITORY_FRANCHISE");

  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/dealer/apply");
    await expect(page.getByRole("heading", { name: /Become a GoKesari dealer/ })).toBeVisible({ timeout: 60_000 });
    const text = await mainText(page);
    expect(text).toContain("Authorised dealers bring shops onto GoKesari and earn commission on every shop that goes live. Choose your scheme,");
    expect(text).toContain("Choose your scheme");
    const prices: Record<string, string> = { FREE: "Free", BUSINESS_PARTNER: "₹12,980", GROWTH_PARTNER: "₹24,780" };
    for (const code of codes) expect(text, `${code} card`).toContain(prices[code] ?? "");
    expect(text).not.toMatch(/Territory Franchise\s+₹/);
    const link = page.getByRole("link", { name: "Book a franchise zone" }).first();
    expect(await link.getAttribute("href")).toMatch(/^\/franchise/);
    await expect(page.getByRole("button", { name: /^Choose / }), "no Choose before the first save").toHaveCount(0);
  } finally {
    await context.close();
  }

  const phone = await pageAs(browser, "customer", PHONE);
  try {
    await phone.page.goto("/dealer/apply");
    await expect(phone.page.getByRole("heading", { name: /Become a GoKesari dealer/ })).toBeVisible({ timeout: 60_000 });
    await expectNoSideScroll(phone.page, "/dealer/apply at 375 px");
  } finally {
    await phone.context.close();
  }
  return `offered ${codes.join(", ")} (no franchise card); Book a franchise zone link; no Choose before saving; 375 px without sideways scroll`;
}, { ...signed, partial: "Saving step 1, choosing Business Partner (joining-charge box, audit) and the questions on a phone need a saved application, which would be created for the customer" });

qa(["TC-DPLT-010", "TC-DPLT-047", "TC-DPLT-049"], "applicant-side refusals: choosing a scheme before saving details 422, a guest 401, changing scheme without being an approved dealer 409, a dealer logo from a customer 403", async () => {
  const customer = await as("customer");
  const free = byCode(await schemes(), "FREE");
  const v2 = need(free.versions.find((v) => v.status === "PUBLISHED"), "Free's published version");

  const choose = await call(customer, "POST", "/api/dealer/application/scheme", { versionId: v2.id });
  expectStatus(choose, 422, "choose before saving details");
  expect(message(choose)).toBe("Save your details first.");
  const guest = await guestCall("GET", "/api/dealer/application/scheme");
  expectStatus(guest, 401, "signed out");
  expect(message(guest)).toBe(SIGN_IN);

  const changeGet = await call(customer, "GET", "/api/dealer/scheme/change");
  const changePost = await call(customer, "POST", "/api/dealer/scheme/change", { versionId: v2.id, termsHash: v2.termsHash });
  for (const [what, res] of [["GET", changeGet], ["POST", changePost]] as const) {
    expectStatus(res, 409, `scheme change ${what} as a non-dealer`);
    expect(message(res)).toBe("Only an approved dealer can change his scheme.");
  }

  const logo = await call(customer, "POST", "/api/dealer/logo", {});
  expectStatus(logo, 403, "dealer logo from a customer");
  expect(message(logo)).toBe("Only a GoKesari dealer can set a dealer logo.");
  return "choose 422 “Save your details first.”; guest 401; scheme change GET / POST 409; logo 403";
}, { ...signed, partial: "The draft, submitted, franchise-owner and approved-dealer steps (and the logo upload itself) need dealer test accounts in those states, which do not exist on staging" });

qa("TC-DPLT-048", "staff move a dealer only with a reason and only to terms he accepted: a 2-character reason 422, an unaccepted Business Partner 409; the dealer stays on his scheme", async () => {
  const admin = await as("admin");
  const list = await call(admin, "GET", "/api/admin/dealers?status=APPROVED");
  const rows = (Object.values(list.body).find(Array.isArray) ?? []) as { id: string; isInternal?: boolean; legalName?: string }[];
  const dealer = need(rows.find((d) => !d.isInternal && /QA Staging Test Dealer/.test(d.legalName ?? "")) ?? rows.find((d) => !d.isInternal), "an approved test dealer");
  const bp = need(byCode(await schemes(), "BUSINESS_PARTNER").versions.find((v) => v.status === "PUBLISHED"), "Business Partner's published version");

  const short = await call(admin, "POST", `/api/admin/dealers/${dealer.id}/scheme`, { versionId: bp.id, reason: "ok" });
  expectStatus(short, 422, "reason ok");
  expect(message(short)).toBe("Please check the highlighted fields.");
  const unaccepted = await call(admin, "POST", `/api/admin/dealers/${dealer.id}/scheme`, { versionId: bp.id, reason: "QA refused write" });
  expectStatus(unaccepted, 409, "move to an unaccepted scheme");
  expect(message(unaccepted)).toBe("The dealer has not accepted that scheme's terms. He accepts them from his dealer page first (explicit acceptance is required for a change of terms).");
  return `${dealer.legalName}: reason “ok” 422; Business Partner not accepted 409`;
}, { ...signed, partial: "The unpaid-charge 409, a successful move (DZ) and the Dealership Manager's 403 need dealers who accepted a paid scheme and a role grant, which do not exist on staging" });

/* ================================================================== admin dealer page */

qa("TC-DPLT-060", "the admin dealer page shows a Scheme card with the dealer's version and start date; GoKesari Direct has no Scheme card", async ({ browser }) => {
  const admin = await as("admin");
  const list = await call(admin, "GET", "/api/admin/dealers?status=APPROVED");
  const rows = (Object.values(list.body).find(Array.isArray) ?? []) as { id: string; isInternal?: boolean; legalName?: string }[];
  const dealer = need(rows.find((d) => !d.isInternal), "an approved test dealer");
  const direct = rows.find((d) => d.isInternal);
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto(`/admin/dealers/${dealer.id}`);
    await expect(page.getByText(/version \d+ · .+ · since \d{1,2} [A-Z][a-z]{2} 20\d\d/).first()).toBeVisible({ timeout: 60_000 });
    const text = await mainText(page);
    expect(text).toMatch(/Scheme (Free Dealership|Business Partner|Growth Partner|Territory Franchise) version \d+ · /);
    let directNote = "no internal dealer listed";
    if (direct) {
      await page.goto(`/admin/dealers/${direct.id}`);
      await expect(page.getByText(direct.legalName ?? "GoKesari Direct").first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/version \d+ · .+ · since /), "no Scheme card for GoKesari Direct").toHaveCount(0);
      directNote = `${direct.legalName}: no Scheme card`;
    }
    return `${dealer.legalName}: ${text.match(/Scheme \S+ \S+ version \d+ · [^·]+ · since [^A-Z]+[A-Z][a-z]{2} 20\d\d/)?.[0]}; ${directNote}`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "A Growth Partner dealer with a two-row scheme history and a pending applicant with scheme answers do not exist on staging" });

/* ================================================================== dashboard */

interface Dashboard {
  dealers: { total: number; byStatus: Record<string, number>; free: number; paid: number; franchise: number };
  money?: Record<string, number>;
}

qa(["TC-DPLT-056", "TC-DPLT-057"], "dealer platform dashboard: filters, every tile and table, a scheme filter, a dealer link, a phone layout, and money tiles that add up", async ({ browser }) => {
  const api = await call(await as("admin"), "GET", "/api/admin/dealer-dashboard");
  expectStatus(api, 200, "dashboard API");
  const d = api.body as Dashboard;
  const byStatus = Object.values(d.dealers.byStatus).reduce((a, b) => a + b, 0);
  expect(byStatus, "dealers by status add up to the total").toBe(d.dealers.total);

  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/dealers/dashboard");
    await expect(page.getByRole("heading", { name: "Dealer platform dashboard" })).toBeVisible({ timeout: 60_000 });
    const text = await mainText(page);
    for (const t of ["From", "To", "Scheme", "Dealer status", "State (e.g. MH)", "District (e.g. MH-PUN)", "City", "Shop status", "Apply", "Download CSV"]) expect(text, `filter ${t}`).toContain(t);
    for (const t of ["Dealers", "Free / paid / franchise", "Earning in the last 90 days", "Shops onboarded / activated", "GMV (sales)", "Platform revenue", "Commission accrued", "of which monthly (recurring)", "Commission paid", "Commission liability (unpaid)", "Pending settlements", "Net revenue before other costs", "Territory utilisation"]) {
      expect(text, `tile ${t}`).toContain(t);
    }
    for (const t of ["Scheme performance", "Dealers by status", "Registrations by month", "Dealer-wise shops (top 20)"]) expect(text, `table ${t}`).toContain(t);
    expect(text).toMatch(/Territory utilisation \d+(\.\d)?% \(\d+\/\d+ slots, \d+ zones\)/);
    expect(text).toContain(`Free / paid / franchise ${d.dealers.free} / ${d.dealers.paid} / ${d.dealers.franchise}`);

    const rupees = (label: string) => Number((text.match(new RegExp(`${label.replace(/[()]/g, "\\$&")} ₹([\\d,]+)`))?.[1] ?? "NaN").replace(/,/g, ""));
    const revenue = rupees("Platform revenue");
    const accrued = rupees("Commission accrued");
    const net = rupees("Net revenue before other costs");
    expect(net, `net ₹${net} = revenue ₹${revenue} − accrued ₹${accrued} (whole rupees)`).toBeGreaterThanOrEqual(revenue - accrued - 1);
    expect(net).toBeLessThanOrEqual(revenue - accrued + 1);
    const paid = rupees("Commission paid");
    const liability = rupees("Commission liability (unpaid)");
    expect(paid + liability, "paid + unpaid never above accrued").toBeLessThanOrEqual(accrued + 1);

    await page.getByRole("combobox", { name: "Scheme" }).selectOption({ label: "Business Partner" });
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/scheme=BUSINESS_PARTNER/, { timeout: 60_000 });
    await expect(page.getByText("Free / paid / franchise").first()).toBeVisible({ timeout: 60_000 });

    await page.goto("/admin/dealers/dashboard");
    const dealerLink = page.locator("table").filter({ hasText: "Activated" }).last().getByRole("link").first();
    if (await dealerLink.count()) {
      const href = need(await dealerLink.getAttribute("href"), "a dealer link");
      expect(href).toMatch(/^\/admin\/dealers\/[0-9a-f-]{36}$/);
    }
  } finally {
    await context.close();
  }

  const phone = await pageAs(browser, "admin", PHONE);
  try {
    await phone.page.goto("/admin/dealers/dashboard");
    await expect(phone.page.getByRole("heading", { name: "Dealer platform dashboard" })).toBeVisible({ timeout: 60_000 });
    await expectNoSideScroll(phone.page, "dashboard at 375 px");
  } finally {
    await phone.context.close();
  }
  return `${d.dealers.total} dealers (${byStatus} by status); every filter, tile and table shown; net = revenue − accrued; Business Partner filter applied; 375 px without sideways scroll`;
}, { ...signed, partial: "TC-DPLT-057's comparison with order_financials, shops and the ledger needs the database; only the dashboard's own totals are checked against each other" });

qa("TC-DPLT-058", "Download CSV: the file name, the Section,Item,Value header, every section, and no cell that starts a formula", async () => {
  const admin = await as("admin");
  const res = await admin.get("/api/admin/dealer-dashboard?format=csv", { timeout: 120_000 });
  expect(res.status()).toBe(200);
  const disposition = res.headers()["content-disposition"] ?? "";
  expect(disposition).toMatch(/dealer-dashboard-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv/);
  const csv = await res.text();
  const lines = csv.trim().split(/\r?\n/);
  expect(lines[0]).toBe("Section,Item,Value");
  const sections = new Set(lines.slice(1).map((l) => l.split(",")[0].replace(/^"|"$/g, "")));
  for (const s of ["Filters", "Dealers by status", "Dealers by scheme", "Registrations by month", "Shops", "Money (₹)", "Territory", "Scheme performance", "Dealer-wise shops"]) expect([...sections], `section ${s}`).toContain(s);
  const cells = lines.flatMap((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "")));
  const formulas = cells.filter((c) => /^[=+\-@]/.test(c) && !/^-?\d/.test(c));
  expect(formulas, "cells that would run as a formula").toEqual([]);
  const money = lines.filter((l) => l.startsWith("Money"));
  for (const l of money) expect(l, "money in rupees with 2 decimals").toMatch(/,-?\d+\.\d{2}$/);
  return `${disposition.match(/dealer-dashboard-[^";]+/)?.[0]}; ${lines.length} rows; sections ${[...sections].join(" / ")}; no formula cells`;
}, { ...signed, partial: "The formula guard is checked on today's dealer names (none start with =); a dealer named =HYPERLINK(… would have to be created" });

qa("TC-DPLT-059", "who may open the dealer platform screens: a guest goes to sign-in and gets 401, a customer is sent home and gets 403, the operator reads the pages without the create form and is refused a new scheme", async ({ browser }) => {
  const seen: string[] = [];
  for (const path of ["/admin/dealers/dashboard", "/admin/dealers/schemes"]) {
    const ctx = await anonymous();
    try {
      const res = await call(ctx, "GET", path);
      expect([302, 303, 307, 308], `guest ${path}`).toContain(res.status);
      expect(decodeURIComponent(res.location ?? "")).toMatch(new RegExp(`/signin(\\?callbackUrl=${path.replace(/\//g, "\\/")})?`));
      seen.push(`guest ${path} → ${decodeURIComponent(new URL(res.location!, "https://x").pathname + new URL(res.location!, "https://x").search)}`);
    } finally {
      await ctx.dispose();
    }
  }
  const guestApi = await guestCall("GET", "/api/admin/dealer-dashboard");
  expectStatus(guestApi, 401, "guest dashboard API");
  const customerApi = await call(await as("customer"), "GET", "/api/admin/dealer-dashboard");
  expectStatus(customerApi, 403, "customer dashboard API");
  expect(message(customerApi)).toBe(NO_ACCESS_DO);

  const { context, page } = await pageAs(browser, "customer");
  try {
    for (const path of ["/admin/dealers/dashboard", "/admin/dealers/schemes"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      expect(new URL(page.url()).pathname, `customer ${path}`).not.toMatch(/^\/admin\/dealers/);
    }
  } finally {
    await context.close();
  }

  const ops = await pageAs(browser, "ops");
  try {
    await ops.page.goto("/admin/dealers/schemes");
    await expect(ops.page.getByRole("heading", { name: "Dealership & franchise schemes" })).toBeVisible({ timeout: 60_000 });
    await expect(ops.page.getByRole("button", { name: "Create scheme" }), "operator: no create form").toHaveCount(0);
    await ops.page.goto("/admin/dealers/dashboard");
    await expect(ops.page.getByRole("heading", { name: "Dealer platform dashboard" })).toBeVisible({ timeout: 60_000 });
  } finally {
    await ops.context.close();
  }
  const before = await schemes();
  const opCreate = await call(await as("ops"), "POST", "/api/admin/dealer-schemes", { code: "QA_REFUSED", name: "QA refused", category: "DEALERSHIP", reason: "QA refused write" });
  expectStatus(opCreate, 403, "operator creates a scheme");
  expect(message(opCreate)).toBe("You may not change dealer schemes.");
  expect(fingerprint(await schemes())).toBe(fingerprint(before));
  return `${seen.join("; ")}; guest API 401; customer sent home and API 403; operator reads both pages, no create form, POST 403`;
}, { ...signed, partial: "The programme-off step (dealer_programme_enabled off: 404 pages and API) would switch the dealer programme off on staging, so it is not done" });
