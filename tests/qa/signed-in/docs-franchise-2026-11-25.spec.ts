/**
 * Shop documents & licences (TC-DOC-…) and Franchise & territory zones (TC-FRN-…): the cases of the 23-Nov-2026
 * plan that were declared manual and can run on test.gokesari.com with the existing test accounts (25-Nov-2026).
 *
 * What these checks may do on staging:
 *   - read public and admin pages and APIs;
 *   - send writes the server must REFUSE (bad bodies, wrong role, wrong agreement version, an over-size upload).
 *     Every refused body is built so that it is refused before anything is saved (validated by the route's schema or
 *     by a check that runs before the database write). Each check reads the data again afterwards where a broken
 *     guard could have changed it.
 *   - price a franchise cart (POST /api/franchise/cart only previews; it reserves nothing).
 * Nothing changes a rule, a setting, a zone, a coupon, a dealer or a booking. The rest of each case (saving rules,
 * turning switches off, reminders on a back-dated clock, KYC test dealers, Cashfree) stays manual — see `partial`.
 */
import type { Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { anonymous, call, expectStatus, why, type Answer } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";
import { onboardingV2On } from "../lib/onboarding-v2-helpers";

const signed = { tier: "signed" as const, timeout: 300_000 };
const guestUi = { timeout: 300_000 };
const CHECK_FIELDS = "Please check the highlighted fields.";
const NO_ACCESS = "You do not have access to this area.";
const SIGN_IN = "Please sign in to continue.";

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;
const message = (res: Answer) => String(res.body?.error?.message ?? "");

async function guestCall(method: "GET" | "POST", path: string, data?: unknown): Promise<Answer> {
  const ctx = await anonymous();
  try {
    return await call(ctx, method, path, data);
  } finally {
    await ctx.dispose();
  }
}

/** No page content wider than the viewport (a sideways scroll). */
async function expectNoSideScroll(page: Page, what: string) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll, `${what}: page is ${scroll}px wide in a ${width}px viewport (sideways scroll)`).toBeLessThanOrEqual(width + 1);
}

async function mainText(page: Page) {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

/* ================================================================== shop documents */

qa("TC-DOC-029", "documents-step API: guest 401, customer without a registration 404, a non-JSON body 422, promise not boolean or an extra key 422", async () => {
  const path = "/api/shops/registration-draft/documents-step";
  const guest = await guestCall("POST", path, {});
  expectStatus(guest, 401, "signed out");
  expect(message(guest)).toBe(SIGN_IN);

  const customer = await as("customer");
  const none = await call(customer, "POST", path, {});
  expectStatus(none, 404, "customer with no registration in progress");
  expect(message(none)).toBe("Registration in progress was not found.");

  // A Buffer is sent as it is (a string would be serialised as a JSON string, which is valid JSON).
  const notJson = await customer.post(path, { headers: { "content-type": "application/json" }, data: Buffer.from("{not json") });
  expect(notJson.status(), "a body that is not JSON").toBe(422);
  expect(((await notJson.json()) as { error?: { message?: string } }).error?.message).toBe("Request body must be valid JSON.");

  for (const body of [{ promise: "yes" }, { promise: true, extra: 1 }]) {
    const res = await call(customer, "POST", path, body);
    expectStatus(res, 422, `body ${JSON.stringify(body)}`);
    expect(message(res)).toBe(CHECK_FIELDS);
  }
  return "401 signed out; 404 “Registration in progress was not found.”; 422 not JSON; 422 for promise “yes” and an extra key";
}, { ...signed, partial: "An empty body treated as no promise needs a registration in progress (none for the test accounts)" });

interface RuleDoc {
  key: string;
  label: string;
  status: string;
  rules: { id: string; scope: string; scopeLabel: string; level: string; liveShopsDueAt: string | null }[];
}

async function documentRules(): Promise<RuleDoc[]> {
  const res = await call(await as("admin"), "GET", "/api/admin/shop-document-rules");
  expectStatus(res, 200, "admin reads the document rules");
  return res.body.documents as RuleDoc[];
}

function ruleOf(docs: RuleDoc[], key: string, scope: string) {
  return docs.find((d) => d.key === key)?.rules.find((r) => r.scope === scope);
}

qa(["TC-DOC-036", "TC-DOC-053"], "Document rules page: the explanation, the Doctors scope and today's seeded rules on each card", async ({ browser }) => {
  const docs = await documentRules();
  const seeded: [string, string, string][] = [
    ["SHOP_ACT", "ALL", "PROMISE"],
    ["UDYAM", "ALL", "OPTIONAL"],
    ["FSSAI", "FOOD", "MUST_HAVE"],
    ["DRUG_LICENCE", "TYPE:PHARMACY", "PROMISE"],
    ["MEDICAL_REGISTRATION", "DOCTOR", "PROMISE"],
  ];
  for (const [key, scope, level] of seeded) expect(ruleOf(docs, key, scope)?.level, `${key} — ${scope}`).toBe(level);
  for (const key of ["DRUG_LICENCE", "MEDICAL_REGISTRATION"]) {
    for (const r of docs.find((d) => d.key === key)!.rules) expect(r.liveShopsDueAt, `${key} ${r.scope}: live-shop date`).toBeTruthy();
  }
  const unasked = ["TRADE_LICENCE", "LEGAL_METROLOGY", "FIRE_NOC", "AGRI_INPUT_LICENCE"].filter((k) => (docs.find((d) => d.key === k)?.rules.length ?? 0) === 0);

  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/shop-documents");
    await expect(page.getByRole("heading", { name: "Shop documents" })).toBeVisible({ timeout: 60_000 });
    const text = await mainText(page);
    for (const line of [
      "Which licences and legal documents each kind of shop needs: must-have before going live, upload later on the owner's promise, or optional. Add a document when a law starts requiring it.",
      "GST number or PAN — always a must-have for every shop (owner rule DF-08). It is not changed here.",
      "The owner cannot pay the registration fee (or go live) until it is uploaded.",
      "The shop may go live once the owner promises to upload it; e-mail reminders, then suspension after the due date.",
      "Shown as an optional upload; never chased.",
      "\"Doctors\" means a shop in any Health doctor category (not Therapy or Diagnostics).",
      "Doctors (shops in a Health doctor category)",
      "New shops follow the rule at once.",
    ]) {
      expect(text, `page text: ${line}`).toContain(line);
    }
    expect(text).toMatch(/shops already live: by \d{1,2} [A-Z][a-z]{2} 20\d\d/);
    if (unasked.length) expect(text).toContain("Not asked of any shop yet");
  } finally {
    await context.close();
  }
  return `seeded rules as designed (Shop Act promise, Udyam optional, FSSAI food must-have, drug licence pharmacy promise, medical registration Doctors promise); ${unasked.length} documents not asked of any shop yet`;
}, { ...signed, partial: "Exact due dates (20 Feb 2027) are read as a date, not compared; the “Add a rule for” list is read as text, not opened" });

qa("TC-DOC-052", "migrations 0159 / 0163 / 0165 are in place: the seeded rules, the Doctors scope and the built-in documents are served", async () => {
  const docs = await documentRules();
  const keys = docs.map((d) => d.key);
  for (const k of ["SHOP_ACT", "UDYAM", "FSSAI", "DRUG_LICENCE", "MEDICAL_REGISTRATION", "TRADE_LICENCE", "LEGAL_METROLOGY", "FIRE_NOC", "AGRI_INPUT_LICENCE"]) expect(keys, k).toContain(k);
  const medical = docs.find((d) => d.key === "MEDICAL_REGISTRATION")!.rules.map((r) => r.scope).sort();
  expect(medical).toEqual(expect.arrayContaining(["DOCTOR", "TYPE:DOCTOR_CLINIC", "TYPE:PROFESSIONAL_OFFICE", "TYPE:SUPER_SPECIALITY_CLINIC"]));
  for (const d of docs) {
    const scopes = d.rules.map((r) => r.scope);
    expect(new Set(scopes).size, `${d.key}: one rule per scope`).toBe(scopes.length);
    for (const s of scopes) expect(s, `${d.key} scope`).toMatch(/^(ALL|FOOD|DOCTOR|TYPE:[A-Z0-9_]+)$/);
    if (!["SHOP_ACT", "UDYAM", "FSSAI", "DRUG_LICENCE", "MEDICAL_REGISTRATION", "TRADE_LICENCE", "LEGAL_METROLOGY", "FIRE_NOC", "AGRI_INPUT_LICENCE"].includes(d.key)) {
      expect(d.key, "an added document's key").toMatch(/^DOC:/);
    }
  }
  return `${docs.length} documents; medical registration scopes ${medical.join(", ")}; one rule per document and scope`;
}, { ...signed, partial: "Read through the admin API: the migration journal, the table check constraint and the 90-day dates' origin are not read (no database access on staging)" });

qa(["TC-DOC-039", "TC-DOC-044"], "document rule API refuses days outside 7–365, an unknown document, scope or shop type, a long note and a bad rule id; nothing is saved", async () => {
  const admin = await as("admin");
  const before = JSON.stringify(await documentRules());
  const tries: [string, Record<string, unknown>, number, string][] = [
    ["6 days", { docKey: "FIRE_NOC", scope: "ALL", level: "PROMISE", liveShopDays: 6 }, 422, CHECK_FIELDS],
    ["366 days", { docKey: "FIRE_NOC", scope: "ALL", level: "PROMISE", liveShopDays: 366 }, 422, CHECK_FIELDS],
    ["unknown document", { docKey: "NOT_A_DOC", scope: "ALL", level: "OPTIONAL" }, 404, "Document was not found."],
    ["scope everyone", { docKey: "FIRE_NOC", scope: "everyone", level: "OPTIONAL" }, 422, "Choose who the rule applies to."],
    ["unknown shop type", { docKey: "FIRE_NOC", scope: "TYPE:NO_SUCH_TYPE", level: "OPTIONAL" }, 422, "Unknown shop type."],
    ["301-character note", { docKey: "FIRE_NOC", scope: "ALL", level: "OPTIONAL", note: "x".repeat(301) }, 422, CHECK_FIELDS],
  ];
  const seen: string[] = [];
  for (const [what, body, status, text] of tries) {
    const res = await call(admin, "PUT", "/api/admin/shop-document-rules", body);
    expectStatus(res, status, what);
    expect(message(res), what).toBe(text);
    seen.push(`${what} ${res.status}`);
  }
  const bad = await call(admin, "DELETE", "/api/admin/shop-document-rules/not-a-uuid");
  expectStatus(bad, 422, "DELETE a bad rule id");
  expect(message(bad)).toBe("Unknown rule.");
  expect(JSON.stringify(await documentRules()), "the rules are unchanged").toBe(before);
  return `${seen.join("; ")}; DELETE not-a-uuid 422 “Unknown rule.”; rules unchanged`;
}, { ...signed, partial: "TC-DOC-039: the browser's 7–365 number field, saving 7 and 365 day rules and the disabled field for Optional are not done (they would change staging's rules)" });

qa("TC-DOC-047", "added-document names and law notes are checked: a short or bad name 422, a built-in name 409, a short law note 422, a missing law note 422; nothing is added", async () => {
  const admin = await as("admin");
  const before = (await documentRules()).length;
  const base = { needsNumber: false, needsExpiry: false, needsAuthority: false };
  const nameRule = "Name the document in 3–80 characters: letters, digits, spaces and & / ( ) . , ' -";
  const tries: [string, Record<string, unknown>, number, string][] = [
    ["name NO", { ...base, label: "NO", lawNote: "QA check: refused" }, 422, nameRule],
    ["name Licence #5", { ...base, label: "Licence #5", lawNote: "QA check: refused" }, 422, nameRule],
    ["81-character name", { ...base, label: "A".repeat(81), lawNote: "QA check: refused" }, 422, nameRule],
    ["built-in Fire NOC", { ...base, label: "Fire NOC", lawNote: "QA check: refused" }, 409, "Fire NOC is already in the list. Change its rules instead."],
    // The name and the law note are both checked before the insert, so a new name with a short note saves nothing.
    ["4-character law note", { ...base, label: "QA refused document", lawNote: "abcd" }, 422, "Say which law (or why) the document is needed, in 5–300 characters."],
    ["missing law note", { ...base, label: "QA refused document" }, 422, CHECK_FIELDS],
  ];
  const seen: string[] = [];
  for (const [what, body, status, text] of tries) {
    const res = await call(admin, "POST", "/api/admin/shop-document-types", body);
    expectStatus(res, status, what);
    expect(message(res), what).toBe(text);
    seen.push(`${what} ${res.status}`);
  }
  expect((await documentRules()).length, "no document was added").toBe(before);
  return seen.join("; ");
}, {
  ...signed,
  partial: "Repeating an added document (“pollution control noc”) needs one to be added first, so it is not sent; the disabled “Add document” button is not checked",
});

qa("TC-DOC-045", "Document rules page on a phone: no sideways scroll; How it works, the cards' level choices and the Add rule form are on screen", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin", { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  try {
    await page.goto("/admin/shop-documents");
    await expect(page.getByRole("heading", { name: "Shop documents" })).toBeVisible({ timeout: 60_000 });
    await expectNoSideScroll(page, "/admin/shop-documents at 375 px");
    await expect(page.getByText("How it works").first()).toBeVisible();
    const addRule = page.getByRole("button", { name: /Add rule/ }).first();
    await addRule.scrollIntoViewIfNeeded();
    await expect(addRule).toBeVisible();
    const box = await addRule.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 376, "Add rule button inside the screen").toBeTruthy();
    await expectNoSideScroll(page, "after scrolling to Add rule");
  } finally {
    await context.close();
  }
  return "375 px: no sideways scroll; How it works and Add rule on screen";
}, { ...signed, partial: "Changing a level, adding a rule and the Add a document form are not used (they would change staging's rules)" });

qa("TC-DOC-035", "Shops missing documents: header with the next reminder date, Live / Suspended / Awaiting approval, rows with missing or waiting documents, reminders and both links", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/shops/missing-documents", { timeout: 120_000 });
    await expect(page.getByRole("heading", { name: "Shops missing documents" })).toBeVisible({ timeout: 90_000 });
    const text = await mainText(page);
    expect(text).toMatch(/Live shops are reminded on day 1 and 15 of each month \(next: \d{1,2} [A-Z][a-z]{2} 20\d\d\) and suspended automatically after reminder 3\. Documents waiting for our check are not chased\./);
    expect(text).toMatch(/\d+ shops?/);
    expect(text).toMatch(/ missing/);
    expect(text).toMatch(/Reminders: [0-3] of 3/);
    const open = await page.getByRole("link", { name: "Open shop →" }).count();
    const upload = await page.getByRole("link", { name: "Upload for owner →" }).count();
    expect(open, "Open shop links").toBeGreaterThan(0);
    expect(upload, "one Upload for owner link per Open shop link").toBe(open);
    const href = await page.getByRole("link", { name: "Upload for owner →" }).first().getAttribute("href");
    expect(href).toMatch(/^\/admin\/shops\/[0-9a-f-]{36}\/documents/);
    const tabs: string[] = [];
    for (const tab of ["Suspended", "Awaiting approval", "Live"]) {
      await page.getByRole("link", { name: tab, exact: true }).or(page.getByRole("button", { name: tab, exact: true })).first().click();
      await expect(page.getByText(/\d+ shops?/).first()).toBeVisible({ timeout: 60_000 });
      tabs.push(`${tab}: ${(await mainText(page)).match(/(\d+) shops?/)?.[1] ?? "?"}`);
    }
    return `${open} rows with Open shop and Upload for owner (${href}); ${tabs.join(", ")}`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "Badges for rule dates and promises are not required to be present (depends on staging data); the follow-up switched-off notice needs the rule turned off" });

qa("TC-DOC-009", "a full operator opens Shops missing documents, sees Open shop and Upload for owner on each row, and Upload for owner opens the shop's Upload documents page", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "ops");
  try {
    await page.goto("/admin/shops/missing-documents", { timeout: 120_000 });
    await expect(page.getByRole("heading", { name: "Shops missing documents" })).toBeVisible({ timeout: 90_000 });
    const upload = page.getByRole("link", { name: "Upload for owner →" });
    const n = await upload.count();
    if (n === 0) blocked("no shop is missing documents on this site");
    expect(await page.getByRole("link", { name: "Open shop →" }).count()).toBe(n);
    const href = need(await upload.first().getAttribute("href"), "the Upload for owner link");
    await page.goto(href, { timeout: 120_000 });
    expect(new URL(page.url()).pathname).toMatch(/^\/admin\/shops\/[0-9a-f-]{36}\/documents$/);
    const text = await mainText(page);
    expect(text).not.toContain(NO_ACCESS);
    expect(text).toMatch(/Upload documents|Still needed|All required documents are uploaded/);
    return `operator: ${n} rows with both links; ${href} opens for the operator`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "The approval-card links need a pending shop; uploading and Verify & Approve as the operator are not done (they would change a shop's documents)" });

qa("TC-DOC-013", "Upload documents for a shop that is missing documents lists what is still needed, and works on a phone without sideways scroll", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  let href = "";
  try {
    await page.goto("/admin/shops/missing-documents", { timeout: 120_000 });
    await expect(page.getByRole("heading", { name: "Shops missing documents" })).toBeVisible({ timeout: 90_000 });
    href = need(await page.getByRole("link", { name: "Upload for owner →" }).first().getAttribute("href"), "a shop missing documents");
    await page.goto(href, { timeout: 120_000 });
    await expect(page.getByText("Still needed").first()).toBeVisible({ timeout: 60_000 });
  } finally {
    await context.close();
  }
  const phone = await pageAs(browser, "admin", { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  try {
    await phone.page.goto(href, { timeout: 120_000 });
    await expect(phone.page.getByText("Still needed").first()).toBeVisible({ timeout: 60_000 });
    await expectNoSideScroll(phone.page, `${href} at 375 px`);
  } finally {
    await phone.context.close();
  }
  return `${href}: “Still needed” shown; 375 px without sideways scroll`;
}, { ...signed, partial: "The waived-shop warning needs a shop approved without FSSAI, the complete state a shop with every document, and the switched-off state the documentUpload rule turned off; Verify & Approve is not clicked" });

qa("TC-DOC-012", "Shop verification points the owner to Upload documents for a licence copy", async ({ browser }) => {
  const shopId = need(world().shops.A?.id, "the test shop");
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto(`/shop/verification?shop=${shopId}`, { timeout: 120_000 });
    const text = await mainText(page);
    expect(text).toContain("Have a licence certificate to send — FSSAI, drug licence, trade licence or any other? Upload a photo or PDF on");
    // The link in the licence sentence (the Seller Central menu has its own "Upload documents" item).
    const link = page.locator("p", { hasText: "Have a licence certificate to send" }).getByRole("link").first();
    const href = need(await link.getAttribute("href"), "the Upload documents link");
    expect(href).toBe(`/shop/documents?shop=${shopId}`);
    return `verification page links ${href}`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "The FSSAI reminder e-mails and the in-app FSSAI notice links are not opened (no reminder is due for the test shop)" });

qa("TC-DOC-011", "a Shop Act or FSSAI file over 5 MB is refused at upload with the 5 MB message; an 11 MB file with the 10 MB message; nothing is read or saved", async () => {
  const shopId = need(world().shops.A?.id, "the test shop");
  const shop = await as("shop");
  const pdf = (bytes: number) => Buffer.concat([Buffer.from("%PDF-1.4\n% QA over-size test file (not a document)\n"), Buffer.alloc(bytes, 0x20), Buffer.from("\n%%EOF\n")]);
  const upload = (docType: string, buffer: Buffer, name: string, mimeType: string) =>
    shop.post(`/api/shops/${shopId}/documents/read`, { multipart: { docType, source: "FILE", file: { name, mimeType, buffer } }, timeout: 120_000 });
  const seen: string[] = [];
  for (const docType of ["SHOP_ACT", "FSSAI"]) {
    const res = await upload(docType, pdf(6_000_000), "qa-6mb.pdf", "application/pdf");
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (res.status() === 409 && /switched off/.test(body.error?.message ?? "")) blocked("document upload (rule documentUpload) is switched off on this site");
    expect(res.status(), `${docType} 6 MB PDF — ${body.error?.message}`).toBe(422);
    expect(body.error?.message).toBe("This document can be at most 5 MB. Upload a smaller PDF, or take a photo of it instead.");
    seen.push(`${docType} 6 MB 422`);
  }
  // An 11 MB file: the page shrinks photos over 2.5 MB before sending but sends a PDF as it is, so an 11 MB PDF is
  // what reaches the server from the page (D-165: the body is cut at 10 MB and the server answers "Attach the document").
  const big = await upload("SHOP_ACT", pdf(11_000_000), "qa-11mb.pdf", "application/pdf");
  const bigBody = (await big.json().catch(() => ({}))) as { error?: { message?: string } };
  expect(big.status(), `11 MB file — ${bigBody.error?.message}`).toBe(422);
  expect(bigBody.error?.message, "11 MB file").toBe("The file can be at most 10 MB. Take the photo again at a lower size or upload a smaller PDF.");
  seen.push("11 MB file 422");
  return seen.join("; ");
}, { ...signed, partial: "Sent to the upload API, not through the page; the 4.9 MB file and the 6 MB PAN / GSTIN file would be read and kept, so they are not sent" });

/* ================================================================== franchise */

interface Offer {
  bookingOpen: boolean;
  launch: { open: boolean; placesLeft: number; placesTotal: number };
  gstRateBp: number;
  validityMonths: number;
  maxOwnersPerZone: number;
  maxZonesPerBooking: number;
  promoFeePaise: number | null;
}
interface Zone {
  zoneId: string;
  zoneSetCode: string;
  name: string;
  tier: string | null;
  slotsFree: number;
  maxOwners: number;
  status: string;
  regularFeePaise: number | null;
  feePaise: number | null;
}

async function zonesApi(query = ""): Promise<{ zones: Zone[]; offer: Offer; facets: unknown }> {
  const res = await guestCall("GET", `/api/franchise/zones${query}`);
  expectStatus(res, 200, `GET /api/franchise/zones${query}`);
  return res.body;
}

qa("TC-FRN-001", "the franchise page shows the launch counter, the launch fee, the regular rate range, the tier counts and the earnings from the live settings", async ({ page }) => {
  const { zones, offer } = await zonesApi();
  const regular = zones.map((z) => z.regularFeePaise ?? 0).filter((n) => n > 0);
  const tiers = (t: string) => zones.filter((z) => z.tier === t).length;
  await page.goto("/franchise");
  await expect(page.getByRole("heading", { name: "GoKesari Territory Franchise" })).toBeVisible({ timeout: 60_000 });
  const text = await mainText(page);
  expect(text).toContain(`${zones.length} zones`);
  if (offer.launch.open) expect(text).toContain(`Launch offer: ${offer.launch.placesLeft} of ${offer.launch.placesTotal} places left`);
  expect(text).toContain(
    `Launch offer ${rupees(offer.promoFeePaise ?? 0)} + GST a year for every zone (regular rates ${rupees(Math.min(...regular))} to ${rupees(Math.max(...regular))}, by zone) · ${offer.validityMonths} months · 100% upfront, online · at most ${offer.maxOwnersPerZone} franchises a zone`,
  );
  for (const [tier, label] of [["PREMIER", "Premier"], ["STANDARD", "Standard"], ["EMERGING", "Emerging"]] as const) expect(text).toContain(`${label} ${tiers(tier)} zones`);
  for (const link of ["See the zones", "My franchise", "Commission chart"]) await expect(page.getByRole("link", { name: link }).first()).toBeVisible();
  expect(text).toContain("Your own shops: 25% of the registration fee (excluding GST) — ₹250 on a ₹1,000 retail shop.");
  expect(text).toContain("+91 91751 93009");
  return `${zones.length} zones; launch ${offer.launch.placesLeft} of ${offer.launch.placesTotal} places left; fee ${rupees(offer.promoFeePaise ?? 0)}; regular ${rupees(Math.min(...regular))}–${rupees(Math.max(...regular))}; tiers ${tiers("PREMIER")}/${tiers("STANDARD")}/${tiers("EMERGING")}`;
}, { ...guestUi, mobile: true, partial: "The illustration box and the free-dealer card are not read line by line" });

qa("TC-FRN-002", "Book a franchise zone: header, tier chips with counts, the zone count, chip / region / slots / fee / search filters, and a Select on every card", async ({ page }) => {
  const { zones, offer } = await zonesApi();
  const count = (t: string) => zones.filter((z) => z.tier === t).length;
  await page.goto("/franchise/book");
  await expect(page.getByRole("heading", { name: "Choose your franchise zones" })).toBeVisible({ timeout: 60_000 });
  const counter = page.getByTestId("zone-count");
  await expect(counter).toHaveText(`${zones.length} of ${zones.length} zones · at most ${offer.maxOwnersPerZone} franchises per zone`);
  for (const [t, label] of [["PREMIER", "Premier"], ["STANDARD", "Standard"], ["EMERGING", "Emerging"]] as const) await expect(page.getByTestId(`tier-${t}`)).toHaveText(new RegExp(`${label}\\s*·\\s*${count(t)}`));
  await expect(page.getByText("Select a zone, then choose: work in it free as a dealer, or own it as a franchise (pay online, KYC after).")).toBeVisible();

  await page.getByTestId("tier-PREMIER").click();
  await expect(counter).toContainText(`${count("PREMIER")} of ${zones.length} zones`);
  await page.getByTestId("tier-PREMIER").click();
  await expect(counter).toContainText(`${zones.length} of ${zones.length} zones`);

  const fringe = zones.filter((z) => /Fringe/.test(JSON.stringify(z))).length;
  await page.getByTestId("zone-region").selectOption({ label: "Fringe" });
  await expect(counter).toContainText(`of ${zones.length} zones`);
  const fringeShown = Number((await counter.innerText()).split(" ")[0]);
  expect(fringeShown, "Fringe zones shown").toBeGreaterThan(0);
  await page.getByTestId("zone-region").selectOption({ index: 0 });

  const oneLeft = zones.filter((z) => z.slotsFree === 1 && z.maxOwners === 2).length;
  await page.getByRole("combobox", { name: "Slots" }).selectOption({ label: "1 slot left" });
  await expect(counter).toContainText(`${oneLeft} of ${zones.length} zones`);
  await page.getByRole("combobox", { name: "Slots" }).selectOption({ label: "Slots available now" });
  await expect(counter).toContainText(`${zones.filter((z) => z.slotsFree > 0).length} of ${zones.length} zones`);
  await page.getByRole("combobox", { name: "Slots" }).selectOption({ index: 0 });

  const fee = offer.promoFeePaise ?? 0;
  await page.getByPlaceholder("Min fee ₹").fill(String(fee / 100 + 10_000));
  await expect(counter).toContainText(`0 of ${zones.length} zones`);
  await page.getByPlaceholder("Min fee ₹").fill("");
  await page.getByPlaceholder("Max fee ₹").fill(String(fee / 100));
  await expect(counter).toContainText(`${zones.length} of ${zones.length} zones`);
  await page.getByPlaceholder("Max fee ₹").fill("");

  await page.getByTestId("zone-search").fill("Koregaon");
  await expect(page.getByTestId("zone-card-GKZ-PUN-17")).toBeVisible();
  await expect(page.getByTestId("zone-select-GKZ-PUN-17")).toHaveText(/Select/);
  return `${zones.length} zones; chips ${count("PREMIER")}/${count("STANDARD")}/${count("EMERGING")}; Fringe ${fringeShown} (API mentions ${fringe}); 1 slot left ${oneLeft}; fee filters at the ${rupees(fee)} launch fee; Koregaon → GKZ-PUN-17`;
}, { ...guestUi, partial: "The chip's fill colour is not compared" });

qa("TC-FRN-004", "every zone name starts once with its city; the test zone is not listed; GKZ-PUN-17's page and tab title carry the city prefix and the code", async ({ page }) => {
  const { zones } = await zonesApi();
  const city: Record<string, string> = { PUN: "Pune – ", MUM: "Mumbai – ", NSK: "Nashik – " };
  const bad = zones.filter((z) => {
    const prefix = city[z.zoneSetCode];
    // "Nashik – Nashik Road–Deolali" is right (Nashik Road is a locality); only a doubled prefix is wrong.
    return !prefix || !z.name.startsWith(prefix) || z.name.slice(prefix.length).startsWith(prefix);
  });
  expect(bad.map((z) => `${z.zoneId} ${z.name}`), "zone names without exactly one city prefix").toEqual([]);
  expect(zones.some((z) => z.zoneId === "T-QA1"), "the hidden test zone").toBe(false);
  const named = Object.fromEntries(zones.filter((z) => ["GKZ-PUN-17", "GKZ-MUM-09", "GKZ-NSK-01"].includes(z.zoneId)).map((z) => [z.zoneId, z.name]));
  expect(named).toEqual({ "GKZ-PUN-17": "Pune – Koregaon Park–Mundhwa", "GKZ-MUM-09": "Mumbai – Bandra–Khar", "GKZ-NSK-01": "Nashik – Old Nashik–Panchavati" });
  await page.goto("/franchise/zones/GKZ-PUN-17");
  await expect(page.getByRole("heading", { name: /Pune – Koregaon Park–Mundhwa/ })).toBeVisible({ timeout: 60_000 });
  // The site adds " · GoKesari" to every tab title.
  await expect(page).toHaveTitle(/^Pune – Koregaon Park–Mundhwa \(GKZ-PUN-17\) — GoKesari franchise zone( · GoKesari)?$/);
  return `${zones.length} names start once with their city; T-QA1 not listed; GKZ-PUN-17 title as designed`;
}, guestUi);

qa("TC-FRN-006", "the Map view shows the tier legend and “Tap a zone to select it.”, or says the map cannot load; List brings the zone cards back", async ({ page }) => {
  await page.goto("/franchise/book");
  await expect(page.getByTestId("zone-card-GKZ-PUN-17")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("zone-map-toggle").click();
  const noMap = page.getByText(/The map (is not available on this site|could not be loaded); use the list\./);
  const legend = page.getByText("Tap a zone to select it.");
  await expect(noMap.or(legend).first()).toBeVisible({ timeout: 60_000 });
  const mapShown = await legend.isVisible();
  if (mapShown) for (const t of ["Premier", "Standard", "Emerging"]) await expect(page.getByText(t).first()).toBeVisible();
  await page.getByRole("button", { name: "List" }).click();
  await expect(page.getByTestId("zone-card-GKZ-PUN-17")).toBeVisible({ timeout: 30_000 });
  return mapShown ? "map with legend and “Tap a zone to select it.”; List shows the cards" : `${await noMap.first().innerText()}; List shows the cards`;
}, { ...guestUi, partial: "Selecting a zone by tapping the map, and the circles' colours, are not checked" });

qa("TC-FRN-010", "selecting GKZ-PUN-17 shows the cart bar; Continue asks free dealership or paid franchise with the live rates; Back keeps the selection", async ({ page }) => {
  const { offer } = await zonesApi();
  const fee = rupees(offer.promoFeePaise ?? 0);
  await page.goto("/franchise/book");
  await page.getByTestId("zone-select-GKZ-PUN-17").click({ timeout: 60_000 });
  const bar = page.getByTestId("franchise-cart");
  await expect(bar).toContainText("1 zone selected");
  await expect(bar).toContainText(fee);
  await expect(bar).toContainText("GKZ-PUN-17");
  await expect(bar.getByRole("button", { name: "Clear" })).toBeVisible();
  await page.getByTestId("franchise-continue").click();
  const join = page.getByTestId("franchise-join");
  await expect(join.getByRole("heading", { name: "How do you want to work in Pune – Koregaon Park–Mundhwa?" })).toBeVisible({ timeout: 30_000 });
  const free = page.getByTestId("join-free");
  for (const t of ["No fee", "Free dealership", "Register shops in your zone and build a team.", "Apply free as a dealer"]) await expect(free).toContainText(t);
  const paid = page.getByTestId("join-paid");
  for (const t of ["Franchise (paid)", `${fee} a year + GST for this zone`, `You own the zone (at most ${offer.maxOwnersPerZone} franchises a zone) for ${offer.validityMonths} months.`, "One-time: 25% on shops you register yourself; 4% / 3% on your team's shops."]) {
    await expect(paid).toContainText(t);
  }
  await page.getByRole("button", { name: "Back to zones" }).click();
  await expect(page.getByTestId("franchise-cart")).toContainText("1 zone selected");
  return `cart bar “1 zone selected · ${fee} + GST GKZ-PUN-17”; join step with the free and paid cards; Back keeps the zone`;
}, { ...guestUi, mobile: true, partial: "Every sentence of the two cards is not compared word for word" });

qa(["TC-FRN-011", "TC-FRN-013"], "a guest's paid and free choices go to sign-in with the callback; signed in, the paid link opens the server-priced cart and drops an unknown zone", async ({ page, browser }) => {
  await page.goto("/franchise/book");
  await page.getByTestId("zone-select-GKZ-PUN-17").click({ timeout: 60_000 });
  await page.getByTestId("franchise-continue").click();
  const paidHref = await page.getByTestId("join-paid").getByRole("link", { name: "Sign in to pay" }).getAttribute("href");
  expect(paidHref).toBe("/signin?callbackUrl=%2Ffranchise%2Fbook%3Fzones%3DGKZ-PUN-17%26join%3Dpaid");
  const freeHref = await page.getByTestId("join-free").getByRole("link", { name: "Apply free as a dealer" }).getAttribute("href");
  const v2 = await onboardingV2On("customer");
  // onboarding v2 (on on test.gokesari.com): the free choice signs in to Become a franchisee (/franchise/start).
  expect(freeHref).toBe(v2 ? "/signin?callbackUrl=%2Ffranchise%2Fstart%3Fmodel%3Dfree" : "/signin?callbackUrl=%2Fdealer%2Fapply%3Fzone%3DGKZ-PUN-17");

  const { context, page: c1 } = await pageAs(browser, "customer");
  try {
    if (v2) {
      // v2: a signed-in visitor books through /franchise/start (paid, zones kept); without a live shop he is sent to
      // shop registration first (return=/franchise/start), or told his shop is not live yet.
      await c1.goto("/franchise/book?zones=GKZ-PUN-17,BAD-1&join=paid");
      await c1.waitForURL(/\/(franchise\/start|shop\/register)/, { timeout: 60_000 });
      const landed = new URL(c1.url());
      if (landed.pathname === "/franchise/start") {
        expect(landed.searchParams.get("model")).toBe("paid");
        expect(landed.searchParams.get("zones") ?? "").toContain("GKZ-PUN-17");
      } else {
        expect(landed.searchParams.get("return")).toBe("/franchise/start");
      }
      return `onboarding v2: guest → ${paidHref} and ${freeHref}; signed in, /franchise/book → ${landed.pathname}${landed.search}`;
    }
    await c1.goto("/franchise/book?zones=GKZ-PUN-17,BAD-1&join=paid");
    const summary = c1.getByTestId("franchise-summary");
    await expect(summary.getByRole("heading", { name: "Your cart" })).toBeVisible({ timeout: 60_000 });
    const priced = await call(await as("customer"), "POST", "/api/franchise/cart", { zoneIds: ["GKZ-PUN-17"] });
    expectStatus(priced, 200, "cart preview");
    await expect(c1.getByTestId("franchise-total")).toContainText(rupees(priced.body.totalPaise));
    const text = (await summary.innerText()).replace(/\s+/g, " ");
    expect(text).toContain("GKZ-PUN-17");
    expect(text).not.toContain("BAD-1");
    for (const t of [rupees(priced.body.listPaise), rupees(priced.body.gstPaise)]) expect(text).toContain(t);
    await expect(c1.getByTestId("franchise-buyer")).toBeVisible();
    return `guest → ${paidHref} and ${freeHref}; signed in: Your cart total ${rupees(priced.body.totalPaise)} (fees ${rupees(priced.body.listPaise)}, GST ${rupees(priced.body.gstPaise)}); BAD-1 dropped`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "The real sign-in hop (an e-mailed code) is replaced by the saved customer session; TC-FRN-013's two-zone working-zone select is not used" });

qa(["TC-FRN-012", "TC-FRN-014"], "the dealer application shows the working-zone card for a real zone and none for an unknown or the hidden test zone", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/dealer/apply?zone=GKZ-PUN-17");
    await expect(page.getByRole("heading", { name: /Become a GoKesari dealer/ })).toBeVisible({ timeout: 60_000 });
    const card = page.getByText("Free dealership · working zone Pune – Koregaon Park–Mundhwa (GKZ-PUN-17)");
    await expect(card).toBeVisible({ timeout: 30_000 });
    for (const zone of ["GKZ-PUN-99", "T-QA1"]) {
      await page.goto(`/dealer/apply?zone=${zone}`);
      await expect(page.getByRole("heading", { name: /Become a GoKesari dealer/ })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/Free dealership · working zone/), `no working-zone card for ${zone}`).toHaveCount(0);
    }
    return "GKZ-PUN-17 card shown; none for GKZ-PUN-99 and T-QA1";
  } finally {
    await context.close();
  }
}, { ...signed, partial: "Saving the application with the zone (and the API's 422 for an unknown zone) would create or change the customer's dealer application, so it is not done" });

qa("TC-FRN-007", "franchise pages at 375 px: no sideways scroll on /franchise, /franchise/book, a zone page and the commission chart; the cart bar is fixed with Clear and Continue", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    for (const path of ["/franchise", "/franchise/zones/GKZ-PUN-17", "/dealer/commission-chart", "/franchise/book"]) {
      await page.goto(path, { timeout: 120_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await expectNoSideScroll(page, `${path} at 375 px`);
    }
    await page.getByTestId("zone-select-GKZ-PUN-17").click({ timeout: 60_000 });
    const bar = page.getByTestId("franchise-cart");
    await expect(bar).toBeVisible();
    expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    await expect(bar.getByRole("button", { name: "Clear" })).toBeVisible();
    await expect(page.getByTestId("franchise-continue")).toBeVisible();
    await expectNoSideScroll(page, "/franchise/book with the cart bar");
    await page.getByTestId("franchise-continue").click();
    await expect(page.getByTestId("join-paid")).toBeVisible({ timeout: 30_000 });
    const free = await page.getByTestId("join-free").boundingBox();
    const paid = await page.getByTestId("join-paid").boundingBox();
    expect(free && paid && paid.y >= free.y + free.height - 1, "the two join cards are stacked").toBeTruthy();
    await expectNoSideScroll(page, "join step");
  } finally {
    await context.close();
  }
  return "no sideways scroll on four pages; fixed cart bar with Clear and Continue; join cards stacked";
}, { ...guestUi, partial: "The signed-in cart table, Your details and the rules at 375 px are not opened" });

qa(["TC-FRN-025", "TC-FRN-028", "TC-FRN-039"], "before paying: an old agreement version 409, bad buyer details 422 with each field named, a coupon before the buyer's details 422; nothing is saved", async () => {
  const customer = await as("customer");
  const before = await call(customer, "GET", "/api/franchise/me");
  expectStatus(before, 200, "customer's franchise status");
  expect(before.body.status.hasDealer, "the customer has no dealer account (pay-first buyer)").toBe(false);

  const offer = await guestCall("GET", "/api/franchise/offer");
  expect(offer.body.agreement.version).toBe("2026-11-22");
  const rules = (offer.body.agreement.text as string[]).join(" ");
  for (const t of ["₹1,50,000", "non-refundable", "12 months", "25%", "4% / 3%", "20%"]) expect(rules, `agreement mentions ${t}`).toContain(t);
  const old = await call(customer, "POST", "/api/franchise/agreement", { version: "2026-11-20" });
  expectStatus(old, 409, "accepting an old agreement version");
  expect(message(old)).toBe("The agreement has changed — please read the current version.");

  const buyer = await call(customer, "POST", "/api/franchise/buyer", { name: "Al", mobile: "5123456789", pan: "ABCDE12345" });
  if (buyer.status === 409) expect(message(buyer)).toBe("Franchise payments are not available on this site yet (secure storage is not set up).");
  else {
    expectStatus(buyer, 422, "bad buyer details");
    expect(message(buyer)).toBe("Please check your details.");
    const fields = buyer.body.error?.fields ?? buyer.body.error?.details?.fields ?? {};
    expect(fields).toMatchObject({ name: "Your full name.", mobile: "A 10-digit Indian mobile number.", pan: "PAN like ABCDE1234F." });
  }

  const coupon = await call(customer, "POST", "/api/franchise/cart", { zoneIds: ["GKZ-PUN-17"], couponCode: "QA10" });
  expectStatus(coupon, 422, "a coupon before the buyer's details");
  expect(message(coupon)).toBe("Give your name, mobile and PAN first, then apply the coupon.");

  const after = await call(customer, "GET", "/api/franchise/me");
  expect(after.body.status.hasDealer, "still no dealer account").toBe(false);
  expect(after.body.status.agreementAccepted, "no acceptance recorded").toBe(false);
  return `agreement 2026-11-22 terms listed; old version 409; buyer ${buyer.status} (${why(buyer)}); coupon 422; still no dealer and no acceptance`;
}, {
  ...signed,
  partial: "The clickwrap box, booking before acceptance (needs a dealer), valid / repeated / taken PANs and a coupon after the details are saved need a buyer account that would be created, so they are not done",
});

qa("TC-FRN-043", "franchise owner data is private: a guest 401, a customer without a franchise gets only the public offer and empty lists, another dealer's statement is refused", async () => {
  const guest = await guestCall("GET", "/api/franchise/me");
  expectStatus(guest, 401, "signed out");
  expect(message(guest)).toBe(SIGN_IN);
  const me = await call(await as("customer"), "GET", "/api/franchise/me");
  expectStatus(me, 200, "customer");
  expect(me.body.status.hasDealer).toBe(false);
  expect(me.body.status.missing).toEqual(["your name, mobile and PAN"]);
  expect(me.body.offer?.bookingOpen, "the public offer is included").toBeDefined();
  for (const k of ["areas", "bookings", "shops", "codes", "statements"]) if (k in me.body) expect(me.body[k], k).toEqual([]);
  const st = await call(await as("customer"), "GET", "/api/franchise/statements/00000000-0000-4000-8000-000000000000");
  expectStatus(st, [403, 404], "someone else's (unknown) statement");
  return `guest 401; customer: hasDealer false, missing [your name, mobile and PAN], empty lists; unknown statement ${st.status}`;
}, { ...signed, partial: "No franchise owner exists among the test accounts: D1 / D2's own data, the 403 for another dealer's real statement and the admin PDF / CSV are not checked" });

qa("TC-FRN-040", "My franchise for an account without a franchise: header with Book zones, the free dealer note and empty territories, shops and statements", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/franchise/my");
    await expect(page.getByRole("heading", { name: "My franchise" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("link", { name: "Book zones" }).first()).toBeVisible();
    const text = await mainText(page);
    for (const t of ["My territories", "No zones yet.", "My shops", "Earnings and statements", "Open my statements", "+91 91751 93009"]) expect(text).toContain(t);
    return "empty My franchise: Book zones, My territories (none), My shops, Earnings and statements";
  } finally {
    await context.close();
  }
}, { ...signed, partial: "An owner's summary cards, codes, shops and receipts need a franchise owner test account (none on staging)" });

qa("TC-FRN-026", "receipt pages for a bad or unknown booking id answer the 404 page for a customer", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "customer");
  try {
    const seen: string[] = [];
    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const res = await page.goto(`/franchise/my/receipt/${id}`);
      expect(res?.status(), `receipt ${id}`).toBe(404);
      seen.push(`${id} 404`);
    }
    return seen.join("; ");
  } finally {
    await context.close();
  }
}, { ...signed, partial: "A paid booking's receipt for its owner, another dealer and an operator, and an unpaid booking's receipt, need franchise bookings (none for the test accounts)" });

qa("TC-FRN-038", "franchise coupons: an operator reads the list but is refused a new coupon (403); an admin's coupon with a bad code is refused (422); no coupon is added", async () => {
  const ops = await as("ops");
  const list = await call(ops, "GET", "/api/admin/franchise/coupons");
  expectStatus(list, 200, "operator reads coupons");
  const before = (list.body.coupons as unknown[]).length;
  const valid = { code: "QAREFUSED", name: "QA refused coupon", kind: "PERCENT", percentBp: 1000, appliesTo: "NEW", allZones: true };
  const opWrite = await call(ops, "POST", "/api/admin/franchise/coupons", valid);
  expectStatus(opWrite, 403, "operator creates a coupon");
  expect(message(opWrite)).toBe(NO_ACCESS);
  const bad = await call(await as("admin"), "POST", "/api/admin/franchise/coupons", { ...valid, code: "Q!" });
  expectStatus(bad, 422, "admin: code Q!");
  const after = await call(ops, "GET", "/api/admin/franchise/coupons");
  expect((after.body.coupons as unknown[]).length, "no coupon added").toBe(before);
  return `operator reads ${before} coupons, POST 403; admin code “Q!” 422 (${message(bad)}); none added`;
}, { ...signed, partial: "Creating, editing, pausing, assigning and exporting coupons, and the form's field messages, are not done (they would add coupons on staging)" });

qa(["TC-FRN-046", "TC-FRN-049", "TC-FRN-054"], "admin franchise writes with bad input are refused: Sold Out or a short reason on zone status 422, 3 slots a zone 422, an allocation change with a short reason 422; nothing changes", async () => {
  const admin = await as("admin");
  const zoneBefore = (await zonesApi()).zones.find((z) => z.zoneId === "GKZ-PUN-42");
  const tries: [string, string, string, Record<string, unknown>][] = [
    ["status SOLD_OUT", "POST", "/api/admin/franchise/zones/status", { zoneIds: ["GKZ-PUN-42"], status: "SOLD_OUT", reason: "QA refused status" }],
    ["reason “ab”", "POST", "/api/admin/franchise/zones/status", { zoneIds: ["GKZ-PUN-42"], status: "ON_HOLD", reason: "ab" }],
    ["maxOwners 3", "PATCH", "/api/admin/franchise/zones/GKZ-PUN-36", { action: "maxOwners", maxOwners: 3, reason: "QA refused" }],
    ["allocation reason “ab”", "PATCH", "/api/admin/franchise/allocations/00000000-0000-4000-8000-000000000000", { status: "SUSPENDED", reason: "ab" }],
  ];
  const seen: string[] = [];
  for (const [what, method, path, body] of tries) {
    const res = await call(admin, method as "POST" | "PATCH", path, body);
    expectStatus(res, 422, what);
    seen.push(`${what} 422 (${message(res)})`);
  }
  const zoneAfter = (await zonesApi()).zones.find((z) => z.zoneId === "GKZ-PUN-42");
  expect(zoneAfter?.status, "GKZ-PUN-42 status unchanged").toBe(zoneBefore?.status);
  const pun36 = (await zonesApi()).zones.find((z) => z.zoneId === "GKZ-PUN-36");
  expect(pun36?.maxOwners, "GKZ-PUN-36 still 2 slots").toBe(2);
  return `${seen.join("; ")}; zones unchanged`;
}, {
  ...signed,
  partial: "Real status changes (On Hold, Coming Soon, Inactive), owner notices, maxOwners 1, suspend / resume / terminate / void need changes to staging's zones and franchises and are not done",
});

qa("TC-FRN-056", "the public commission chart shows Model A and Model B with the amounts worked out from the live rates", async ({ page }) => {
  const chart = await guestCall("GET", "/api/franchise/commission-chart");
  expectStatus(chart, 200, "commission chart API");
  const r = chart.body.rates as Record<string, number>;
  expect(r).toMatchObject({ memberDirectBp: 2000, leadOverrideBp: 400, dealerSelfBp: 2000, dealerOverrideBp: 400, dealerSecondOverrideBp: 300, ownerSelfBp: 2500, ownerOverrideBp: 400, ownerSecondOverrideBp: 300 });
  const a = Object.fromEntries((chart.body.modelA as { caseCode: string; amounts: { key: string; total: number }[] }[]).map((c) => [c.caseCode, c.amounts.map((x) => x.total)]));
  const b = Object.fromEntries((chart.body.modelB as { caseCode: string; amounts: { key: string; total: number }[] }[]).map((c) => [c.caseCode, c.amounts.map((x) => x.total)]));
  expect(a).toEqual({ A1: [20000, 50000], A2: [24000, 60000], A3: [27000, 67500], A4: [24000, 60000] });
  expect(b).toEqual({ B1: [25000, 62500], B2: [24000, 60000], B3: [27000, 67500], B4: [24000, 60000] });
  await page.goto("/dealer/commission-chart");
  await expect(page.getByRole("heading", { name: "Commission chart" })).toBeVisible({ timeout: 60_000 });
  const text = await mainText(page);
  for (const t of ["Free Dealership (Model A)", "Paid Franchise (Model B)", "Recurring commission — paid franchise only", "Dealer ₹200", "Owner ₹250", "Owner ₹625", "₹200 + TL ₹40 + Dealer ₹30 = ₹270"]) expect(text, t).toContain(t);
  return "rates 20/4/3 and owner 25/4/3; A1–A4 and B1–B4 amounts as designed for ₹1,000 and ₹2,500 shops; page shows both models and the recurring section";
}, { ...guestUi, mobile: true, partial: "The recurring bonus details and the signed-in /dealer links (dealer and team member accounts) are not read" });
