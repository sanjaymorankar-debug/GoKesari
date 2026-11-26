/**
 * Referral code moves (TC-REFM-…, PR #473): the cases of the 23-Nov-2026 plan that were declared manual and can run
 * on test.gokesari.com with the existing test accounts (25-Nov-2026).
 *
 * What these checks may do on staging, as the staging admin:
 *   - read Admin → Dealers → Referral moves and its APIs;
 *   - raise move requests for test shops and test dealers' members, upload dummy consent letters to them, and
 *     CANCEL every one in a finally block (requests carry the tag below; an earlier run's left-over is cancelled first).
 *     A request moves nothing until a different admin approves it, and staging has no second admin (admin2 is a
 *     customer until the owner approves its ADMIN role), so no shop, code or member ever moves;
 *   - send requests the server must refuse (bad fields and targets, wrong files, decided requests).
 * Approving and rejecting (Admin B), the audit rows (database) and switching the dealer programme off stay manual.
 */
import type { Page } from "@playwright/test";

import { as, me, pageAs } from "../lib/actors";
import { call, expectStatus, RUN, type Answer } from "../lib/http";
import { expect, need, qa } from "../lib/record";

const signed = { tier: "signed" as const, timeout: 300_000 };
const TAG = "QA REFM 25-Nov";
const CHECK_FIELDS = "Please check the highlighted fields.";
const NO_ACCESS = "You do not have access to this area.";
const message = (res: Answer) => String(res.body?.error?.message ?? "");

/** Test data on staging (read 25-Nov-2026): two test dealers, the first with an agent and a team lead. */
const FROM_DEALER = "QA Staging Test Dealer";
const TO_DEALER = "QA Nashik Test Dealer";
/** An E2E shop with no referral team. */
const NO_CODE_SHOP = { id: "9bbea75f-6e76-4ca5-87dc-db14aa35f71b", name: "E2E Referral MV2SEV7D-1" };
/** Two QA shops registered through GoKesari Direct. */
const DIRECT_SHOPS = [
  { id: "0ff927dc-ff96-4b54-b857-ee69a90f7da5", name: "QA Docs 2026-10-29 mvtcd0sw" },
  { id: "5a07d6e0-e8a2-4e20-b82c-d704a69e2775", name: "QA Phase2 Retry 42462" },
];
/** A shop with FROM_DEALER on its field employee's code. */
const TEAM_SHOP = { id: "b77df8e8-e238-4903-b322-54f987a4fa41", name: "QA Assisted Clothing (staging)" };

interface MoveRequest {
  id: string;
  kind: string;
  status: string;
  requestedBy: string;
  reason: string;
  shopIds: string[];
  memberId: string | null;
  missing: { kind: string; shopId: string | null; label: string }[];
  documents: { id: string; kind: string }[];
}
interface Dealer {
  id: string;
  legalName: string;
  isInternal: boolean;
  status: string;
}
interface Member {
  id: string;
  name: string;
  status: string;
  teamRole?: string;
}

async function requests(): Promise<MoveRequest[]> {
  const res = await call(await as("admin"), "GET", "/api/admin/referral-moves");
  expectStatus(res, 200, "admin lists the referral moves");
  return res.body.requests as MoveRequest[];
}

async function dealers(status = "APPROVED"): Promise<Dealer[]> {
  const res = await call(await as("admin"), "GET", `/api/admin/dealers?status=${status}`);
  expectStatus(res, 200, `${status} dealers`);
  return (Object.values(res.body).find(Array.isArray) ?? []) as Dealer[];
}

async function dealerByName(name: string): Promise<Dealer> {
  return need((await dealers()).find((d) => d.legalName === name && !d.isInternal), `the approved test dealer “${name}”`);
}

async function membersOf(dealerId: string): Promise<Member[]> {
  const res = await call(await as("admin"), "GET", `/api/admin/dealers/${dealerId}`);
  expectStatus(res, 200, "dealer details");
  const found: Member[] = [];
  const walk = (o: unknown) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) if (k === "salespeople" && Array.isArray(v)) found.push(...(v as Member[]));
        else walk(v);
    }
  };
  walk(res.body);
  return found;
}

/** Cancels the admin's own waiting requests from this suite (an earlier run's, or this test's). */
async function cancelOwn(note = "QA cleanup: cancelling my own test request") {
  const adminId = (await me("admin")).id;
  const admin = await as("admin");
  const out: string[] = [];
  for (const r of await requests()) {
    if (r.status === "PENDING" && r.requestedBy === adminId && r.reason.startsWith(TAG)) {
      const res = await call(admin, "POST", `/api/admin/referral-moves/${r.id}`, { action: "cancel", note });
      expectStatus(res, 200, `cancel ${r.id}`);
      out.push(r.id.slice(0, 8));
    }
  }
  return out;
}

async function raise(body: Record<string, unknown>): Promise<string> {
  const res = await call(await as("admin"), "POST", "/api/admin/referral-moves", body);
  expectStatus(res, 201, "raise the move request");
  return String(res.body.id);
}

/** Runs `body` with this suite's requests cancelled before and after, whatever happens. */
async function withCleanup<T>(body: () => Promise<T>): Promise<T> {
  await cancelOwn("QA cleanup of an earlier run");
  try {
    return await body();
  } finally {
    await cancelOwn();
  }
}

async function mainText(page: Page) {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

/* ================================================================== the screen */

qa("TC-REFM-001", "Referral moves opens from Admin → Dealers with the new-request card (buttons, disabled Search and Raise request, the dealer's own code first) and lists approved dealers only", async ({ browser }) => {
  const approved = await dealers();
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/dealers");
    await page.getByRole("link", { name: "Referral moves", exact: true }).first().click({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/admin\/dealers\/referral-moves$/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Referral moves" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("link", { name: "← Dealers" })).toBeVisible();
    expect(await mainText(page)).toMatch(/consent letters?/i);
    const card = page.getByTestId("referral-move-new");
    await expect(card.getByRole("button", { name: "Shops (add / move a referral code)" })).toBeVisible();
    await expect(card.getByRole("button", { name: "A team member with his code and shops" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Search" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Raise request" })).toBeDisabled();
    const whose = card.getByLabel("Whose referral code");
    await expect(whose).toBeDisabled();
    await expect(whose.locator("option").first()).toHaveText("The dealer's own code");
    await expect(card.getByLabel("Reason (logged)")).toBeVisible();
    const options = (await card.getByLabel("Move to dealer / franchise").locator("option").allInnerTexts()).filter((o) => o !== "Choose…");
    const expected = approved.filter((d) => !d.isInternal).map((d) => d.legalName);
    expect(options.sort()).toEqual(expected.sort());
    expect(options.some((o) => /GoKesari Direct/.test(o)), "GoKesari's own dealer record is not offered").toBe(false);
    return `opens from Dealers; card as designed; “Move to dealer / franchise” lists ${options.length} approved dealers, not GoKesari Direct`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "“No move requests yet.” shows only on a site without requests (staging has earlier ones)" });

qa("TC-REFM-004", "the old one-admin transfer API refuses and points to Referral moves; the operator is refused; the team member stays", async () => {
  const from = await dealerByName(FROM_DEALER);
  const to = await dealerByName(TO_DEALER);
  const member = need((await membersOf(from.id)).find((m) => m.status === "ACTIVE"), `an active member of ${FROM_DEALER}`);
  const path = `/api/admin/dealers/${from.id}/salespeople/${member.id}/transfer`;
  const admin = await call(await as("admin"), "POST", path, { toDealerId: to.id, reason: "test move" });
  expectStatus(admin, 409, "admin");
  expect(message(admin)).toBe("Moving a person to another dealer now needs consent letters and a second admin's approval: use Admin → Dealers → Referral moves.");
  const ops = await call(await as("ops"), "POST", path, { toDealerId: to.id, reason: "test move" });
  expectStatus(ops, 403, "operator");
  expect(message(ops)).toBe(NO_ACCESS);
  const after = (await membersOf(from.id)).find((m) => m.id === member.id);
  expect(after?.status, `${member.name} still active in ${FROM_DEALER}`).toBe("ACTIVE");
  expect((await membersOf(to.id)).some((m) => m.name === member.name), `no new place in ${TO_DEALER}`).toBe(false);
  return `${member.name}: admin 409 pointing to Referral moves; operator 403; still in ${FROM_DEALER}`;
}, signed);

qa("TC-REFM-006", "find shops: Search waits for 2 characters; a name, an owner's phone or a shop id finds the shop with its team and code; Add builds “Chosen (n)” and a click removes one", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/dealers/referral-moves");
    const card = page.getByTestId("referral-move-new");
    const box = card.getByLabel("Find shops (name, phone or shop id)");
    const search = card.getByRole("button", { name: "Search" });
    await box.fill("E");
    await expect(search).toBeDisabled();
    await box.fill("E2E Referral MV2SEV7D");
    await search.click();
    const noCode = card.getByRole("listitem").filter({ hasText: NO_CODE_SHOP.name });
    await expect(noCode).toContainText(`${NO_CODE_SHOP.name} · no referral code`, { timeout: 30_000 });
    expect(await card.getByRole("listitem").count(), "at most 20 hits").toBeLessThanOrEqual(20);
    await noCode.getByRole("button", { name: "Add" }).click();
    await expect(noCode.getByRole("button", { name: "Add" }), "Add is disabled once chosen").toBeDisabled();

    await box.fill(TEAM_SHOP.id);
    await search.click();
    const team = card.getByRole("listitem").filter({ hasText: TEAM_SHOP.name });
    await expect(team).toContainText(new RegExp(`${TEAM_SHOP.name.replace(/[()]/g, "\\$&")} · with ${FROM_DEALER} · code \\S+`), { timeout: 30_000 });
    await team.getByRole("button", { name: "Add" }).click();
    await expect(card.getByText(/Chosen \(2\):/)).toBeVisible();
    await card.getByRole("button", { name: `${NO_CODE_SHOP.name} ✕` }).click();
    await expect(card.getByText(/Chosen \(1\):/)).toBeVisible();
    await expect(card.getByRole("button", { name: `${TEAM_SHOP.name} ✕` })).toBeVisible();
  } finally {
    await context.close();
  }
  const phone = await call(await as("admin"), "GET", "/api/admin/referral-moves/shops?q=73971001");
  expectStatus(phone, 200, "search by phone");
  return `1 letter: Search disabled; by name “${NO_CODE_SHOP.name} · no referral code”; by id “${TEAM_SHOP.name} · with ${FROM_DEALER} · code …”; Chosen (2) → (1); phone search answers ${(phone.body.shops as unknown[]).length} shops`;
}, { ...signed, partial: "The phone search is sent to the API (its hits are not matched to one owner); the 50-shop cap on Add is not reached" });

/* ================================================================== raising requests (cancelled at once) */

qa("TC-REFM-007", "raise a request to give a shop with no code a team member's code: the notice, the pending card and the missing letters; the shop is not changed", async ({ browser }) => {
  const to = await dealerByName(FROM_DEALER);
  const agent = need((await membersOf(to.id)).find((m) => m.status === "ACTIVE" && m.teamRole !== "TEAM_LEAD") ?? (await membersOf(to.id)).find((m) => m.status === "ACTIVE"), `an active member of ${FROM_DEALER}`);
  return withCleanup(async () => {
    const reason = `${TAG} ${RUN} — shop owner forgot the code at sign-up`;
    const { context, page } = await pageAs(browser, "admin");
    try {
      await page.goto("/admin/dealers/referral-moves");
      const card = page.getByTestId("referral-move-new");
      await card.getByLabel("Find shops (name, phone or shop id)").fill(NO_CODE_SHOP.id);
      await card.getByRole("button", { name: "Search" }).click();
      await card.getByRole("listitem").filter({ hasText: NO_CODE_SHOP.name }).getByRole("button", { name: "Add" }).click({ timeout: 30_000 });
      await card.getByLabel("Move to dealer / franchise").selectOption({ label: to.legalName });
      const whose = card.getByLabel("Whose referral code");
      await whose.selectOption(need(await whose.locator("option", { hasText: agent.name }).first().getAttribute("value"), "the member option"));
      await card.getByLabel("Reason (logged)").fill(reason);
      await card.getByRole("button", { name: "Raise request" }).click();
      await expect(page.getByText("Request raised — upload the signed consent letters below; a different admin approves it.")).toBeVisible({ timeout: 60_000 });
      const req = page.getByTestId("referral-move-request").filter({ hasText: reason });
      await expect(req).toHaveCount(1);
      await expect(req).toContainText("pending");
      await expect(req).toContainText(`1 shop → ${to.legalName} · ${agent.name}'s code`);
      await expect(req).toContainText(/raised \d{1,2} [A-Z][a-z]{2} 20\d\d,? \d{1,2}[:.]\d{2}/);
      await expect(req).toContainText(`${NO_CODE_SHOP.name} (no code yet)`);
      await expect(req).toContainText(`Reason: ${reason}`);
      const missing = (await req.getByText(/Missing before approval:/).innerText()).replace(/\s+/g, " ");
      expect(missing).toContain(`Shop owner's signed consent — ${NO_CODE_SHOP.name}`);
      expect(missing).toContain("New dealer / franchise owner's signed consent");
      expect(missing, "no old-dealer letter for a shop with no dealer").not.toContain("Old dealer");
    } finally {
      await context.close();
    }
    const shop = await call(await as("admin"), "GET", `/api/admin/referral-moves/shops?q=${NO_CODE_SHOP.id}`);
    const hit = (shop.body.shops as { id: string; dealerName: string | null; code: string | null }[]).find((s) => s.id === NO_CODE_SHOP.id);
    expect(hit?.dealerName ?? null, "the shop still has no team").toBeNull();
    return `request raised and shown pending “1 shop → ${to.legalName} · ${agent.name}'s code” with the two missing letters; shop unchanged; cancelled`;
  });
}, { ...signed, partial: "The audit row referral_move.requested is not read (database)" });

qa(["TC-REFM-008", "TC-REFM-010"], "raise a two-shop request to a dealer's own code (card and letters), then a second request for a waiting shop and one for a shop already with that team and code are refused", async () => {
  const to = await dealerByName(FROM_DEALER);
  const admin = await as("admin");
  return withCleanup(async () => {
    const reason = `${TAG} ${RUN} — two shops to the dealer's own code`;
    const id = await raise({ kind: "SHOPS", shopIds: DIRECT_SHOPS.map((s) => s.id), toDealerId: to.id, toMemberId: null, reason });
    const req = need((await requests()).find((r) => r.id === id), "the new request");
    expect(req.status).toBe("PENDING");
    const labels = req.missing.map((m) => `${m.label}${m.shopId ? ` — ${m.shopId}` : ""}`);
    for (const s of DIRECT_SHOPS) expect(labels, `shop owner's consent for ${s.name}`).toContain(`Shop owner's signed consent — ${s.id}`);
    expect(labels).toContain("New dealer / franchise owner's signed consent");
    const old = labels.includes("Old dealer / franchise owner's signed consent");

    const again = await call(admin, "POST", "/api/admin/referral-moves", { kind: "SHOPS", shopIds: [DIRECT_SHOPS[0].id], toDealerId: to.id, toMemberId: null, reason: `${TAG} ${RUN} — second request` });
    expectStatus(again, 409, "a shop that already has a waiting move");
    expect(message(again)).toBe("A chosen shop already has a move waiting for approval.");

    const members = await membersOf(to.id);
    const teamCodeHolder = members.find((m) => m.status === "ACTIVE" && m.teamRole !== "TEAM_LEAD");
    const same = await call(admin, "POST", "/api/admin/referral-moves", { kind: "SHOPS", shopIds: [TEAM_SHOP.id], toDealerId: to.id, toMemberId: teamCodeHolder?.id ?? null, reason: `${TAG} ${RUN} — no change really` });
    expectStatus(same, 409, "a shop already with that team and code");
    expect(message(same)).toBe("A chosen shop is already with that team and code.");
    return `2 shops → ${to.legalName} · dealer's own code, letters: ${labels.length} (old-dealer letter ${old ? "listed" : "not listed: the shops came through GoKesari Direct"}); second request 409; same team and code 409; cancelled`;
  });
}, { ...signed, partial: "The two shops come from GoKesari Direct (no other test dealer holds two shops); the second request is raised by the same admin, not Admin B" });

qa("TC-REFM-009", "shop request checks: a blank reason, no shops, 51 shops, an unknown shop, an unapproved dealer, GoKesari Direct and another dealer's member are refused; nothing is created", async () => {
  const admin = await as("admin");
  const to = await dealerByName(TO_DEALER);
  const other = await dealerByName(FROM_DEALER);
  const otherMember = need((await membersOf(other.id)).find((m) => m.status === "ACTIVE"), `a member of ${FROM_DEALER}`);
  const direct = (await dealers()).find((d) => d.isInternal);
  const draft = (await dealers("DRAFT"))[0] ?? (await dealers("PENDING"))[0];
  const before = (await requests()).length;
  const ok = { kind: "SHOPS", shopIds: [NO_CODE_SHOP.id], toDealerId: to.id, toMemberId: null, reason: `${TAG} ${RUN} — refused` };
  const tries: [string, Record<string, unknown>, number, string][] = [
    ["10 spaces as the reason", { ...ok, reason: "          " }, 422, "Give a reason of at least 10 characters."],
    ["no shops", { ...ok, shopIds: [] }, 422, CHECK_FIELDS],
    ["51 shops", { ...ok, shopIds: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) }, 422, CHECK_FIELDS],
    ["an unknown shop", { ...ok, shopIds: ["00000000-0000-4000-8000-000000000001"] }, 404, "Shop was not found."],
    ["another dealer's member", { ...ok, toMemberId: otherMember.id }, 422, "That team member is not in the new dealer's team."],
  ];
  if (draft) tries.push(["a dealer not approved", { ...ok, toDealerId: draft.id }, 409, "The new dealer is not approved."]);
  if (direct) tries.push(["GoKesari Direct", { ...ok, toDealerId: direct.id }, 409, "Shops cannot be moved to GoKesari's own dealer record."]);
  const seen: string[] = [];
  for (const [what, body, status, text] of tries) {
    const res = await call(admin, "POST", "/api/admin/referral-moves", body);
    expectStatus(res, status, what);
    expect(message(res), what).toBe(text);
    seen.push(`${what} ${res.status}`);
  }
  expect((await requests()).length, "no request created").toBe(before);
  return `${seen.join("; ")}; nothing created`;
}, { ...signed, partial: "The UI's disabled button for a 9-character reason and an inactive member (none on staging) are not checked" });

qa(["TC-REFM-011", "TC-REFM-012"], "member move: the form offers the dealer's members and team leads only; the request card and its letters; checks for a missing member, a member already in the team and a second request", async ({ browser }) => {
  const from = await dealerByName(FROM_DEALER);
  const to = await dealerByName(TO_DEALER);
  const members = await membersOf(from.id);
  const member = need(members.find((m) => m.status === "ACTIVE" && m.teamRole !== "TEAM_LEAD") ?? members.find((m) => m.status === "ACTIVE"), `an active member of ${FROM_DEALER}`);
  const admin = await as("admin");
  return withCleanup(async () => {
    const reason = `${TAG} ${RUN} — moving to the Nashik team`;
    const { context, page } = await pageAs(browser, "admin");
    try {
      await page.goto("/admin/dealers/referral-moves");
      const card = page.getByTestId("referral-move-new");
      await card.getByRole("button", { name: "A team member with his code and shops" }).click({ timeout: 60_000 });
      await card.getByLabel("Current dealer / franchise").selectOption({ label: from.legalName });
      const offered = (await card.getByLabel("Team member to move").locator("option").allInnerTexts()).filter((o) => o !== "Choose…");
      for (const o of offered) expect(o).toMatch(/ \((team lead|agent)\)$/);
      expect(offered.length).toBe(members.filter((m) => m.status === "ACTIVE").length);
      const value = need(await card.getByLabel("Team member to move").locator("option", { hasText: member.name }).first().getAttribute("value"), "the member option");
      await card.getByLabel("Team member to move").selectOption(value);
      const targets = await card.getByLabel("Move to dealer / franchise").locator("option").allInnerTexts();
      expect(targets, "the current dealer is not a target").not.toContain(from.legalName);
      await card.getByLabel("Move to dealer / franchise").selectOption({ label: to.legalName });
      const joins = await card.getByLabel("Joins under").locator("option").allInnerTexts();
      expect(joins[0]).toBe("Reports to the dealer");
      for (const j of joins.slice(1)) expect(j, "only team leads").toMatch(/\(team lead\)$/);
      await card.getByLabel("Reason (logged)").fill(reason);
      await card.getByRole("button", { name: "Raise request" }).click();
      await expect(page.getByText("Request raised — upload the signed consent letters below; a different admin approves it.")).toBeVisible({ timeout: 60_000 });
      const req = page.getByTestId("referral-move-request").filter({ hasText: reason });
      await expect(req).toContainText("pending");
      await expect(req).toContainText(`${member.name} (from ${from.legalName}) → ${to.legalName}`);
      const missing = (await req.getByText(/Missing before approval:/).innerText()).replace(/\s+/g, " ");
      for (const l of ["Team member's signed consent", "Old dealer / franchise owner's signed consent", "New dealer / franchise owner's signed consent"]) expect(missing).toContain(l);
      const kinds = await req.getByLabel("Document type").locator("option").allInnerTexts();
      expect(kinds.join(" | ")).not.toContain("Shop owner's signed consent");
    } finally {
      await context.close();
    }

    const base = { kind: "MEMBER", toDealerId: to.id, toMemberId: null, reason: `${TAG} ${RUN} — refused` };
    const noMember = await call(admin, "POST", "/api/admin/referral-moves", base);
    expectStatus(noMember, 422, "no memberId");
    expect([CHECK_FIELDS, "Choose the team member to move."]).toContain(message(noMember));
    const sameTeam = await call(admin, "POST", "/api/admin/referral-moves", { ...base, memberId: member.id, toDealerId: from.id });
    expectStatus(sameTeam, 409, "a member already in that dealer's team");
    expect(message(sameTeam)).toBe("The person is already in this dealer's team.");
    const twice = await call(admin, "POST", "/api/admin/referral-moves", { ...base, memberId: member.id });
    expectStatus(twice, 409, "a member with a waiting move");
    expect(message(twice)).toBe("This person already has a move waiting for approval.");
    expect((await membersOf(from.id)).find((m) => m.id === member.id)?.status, `${member.name} still active in ${FROM_DEALER}`).toBe("ACTIVE");
    return `${member.name} (from ${from.legalName}) → ${to.legalName}: form, card and three missing letters as designed; no member 422, same team 409, second request 409; cancelled`;
  });
}, { ...signed, partial: "The target dealer has no team lead, so “Joins under” offers only “Reports to the dealer” and the non-lead 422 is not sent; an inactive member (none on staging) is not checked" });

/* ================================================================== letters and decisions */

qa(["TC-REFM-014", "TC-REFM-017"], "consent letters: wrong type, too big, empty, no file, no or wrong shop, an unknown type and a decided request are refused, the customer cannot open a letter; the raiser cancels with a note and a decided request cannot be decided again", async ({ browser }) => {
  const to = await dealerByName(FROM_DEALER);
  const admin = await as("admin");
  const decided = need((await requests()).find((r) => r.status !== "PENDING"), "a decided request");
  return withCleanup(async () => {
    const reason = `${TAG} ${RUN} — letters and cancel`;
    const id = await raise({ kind: "SHOPS", shopIds: [NO_CODE_SHOP.id], toDealerId: to.id, toMemberId: null, reason });
    const upload = (reqId: string, fields: Record<string, string>, file?: { name: string; mimeType: string; buffer: Buffer }) =>
      call(admin, "POST", `/api/admin/referral-moves/${reqId}/documents`, undefined, { multipart: { ...fields, ...(file ? { file } : {}) } });
    const pdf = Buffer.from("%PDF-1.4\n% QA dummy letter for a staging test (not a real document)\n%%EOF\n");
    const tries: [string, Promise<Answer>, number, string][] = [
      ["a .txt named .pdf", upload(id, { kind: "TO_DEALER_CONSENT" }, { name: "letter.pdf", mimeType: "application/pdf", buffer: Buffer.from("just text, not a PDF") }), 422, "Upload a PDF, JPEG, PNG or WebP file."],
      ["a 6 MB PDF", upload(id, { kind: "TO_DEALER_CONSENT" }, { name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.concat([pdf, Buffer.alloc(6_000_000, 0x20)]) }), 422, "The file is larger than 5 MB."],
      ["an empty file", upload(id, { kind: "TO_DEALER_CONSENT" }, { name: "empty.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0) }), 422, "The file is empty."],
      ["no file part", upload(id, { kind: "TO_DEALER_CONSENT" }), 422, "Attach the signed consent (PDF or photo)."],
      ["shop owner's consent without a shop", upload(id, { kind: "SHOP_OWNER_CONSENT" }, { name: "l.pdf", mimeType: "application/pdf", buffer: pdf }), 422, "Choose which shop's owner signed this consent."],
      ["shop owner's consent for a shop not in the request", upload(id, { kind: "SHOP_OWNER_CONSENT", shopId: TEAM_SHOP.id }, { name: "l.pdf", mimeType: "application/pdf", buffer: pdf }), 422, "Choose which shop's owner signed this consent."],
      ["kind PASSPORT", upload(id, { kind: "PASSPORT" }, { name: "l.pdf", mimeType: "application/pdf", buffer: pdf }), 422, "Unknown document type."],
      ["a letter for a decided request", upload(decided.id, { kind: "TO_DEALER_CONSENT" }, { name: "l.pdf", mimeType: "application/pdf", buffer: pdf }), 409, "Documents can be added only while the request waits for approval."],
    ];
    const seen: string[] = [];
    for (const [what, pending, status, text] of tries) {
      const res = await pending;
      expectStatus(res, status, what);
      expect(message(res), what).toBe(text);
      seen.push(`${what} ${res.status}`);
    }
    expect(need((await requests()).find((r) => r.id === id), "the request").documents.length, "no letter stored").toBe(0);

    const good = await upload(id, { kind: "TO_DEALER_CONSENT" }, { name: "qa-dummy-to_dealer_consent.pdf", mimeType: "application/pdf", buffer: pdf });
    expectStatus(good, 201, "a dummy PDF letter");
    const docId = need((await requests()).find((r) => r.id === id)?.documents[0]?.id, "the uploaded letter");
    const customer = await call(await as("customer"), "GET", `/api/admin/referral-moves/${id}/documents/${docId}`);
    expectStatus(customer, 403, "the customer opens the letter");
    expect(message(customer)).toBe(NO_ACCESS);

    const shortNote = await call(admin, "POST", `/api/admin/referral-moves/${id}`, { action: "reject", note: "no" });
    expectStatus(shortNote, 422, "a 2-character note");
    expect(message(shortNote)).toBe(CHECK_FIELDS);

    const { context, page } = await pageAs(browser, "admin");
    try {
      await page.goto("/admin/dealers/referral-moves");
      const card = page.getByTestId("referral-move-request").filter({ hasText: reason });
      await card.getByLabel("Note (to cancel your request)").fill("not needed");
      await card.getByRole("button", { name: "Cancel request" }).click();
      await expect(page.getByText("Request cancelled.")).toBeVisible({ timeout: 60_000 });
      await expect(card).toContainText("cancelled");
    } finally {
      await context.close();
    }
    const approveAgain = await call(admin, "POST", `/api/admin/referral-moves/${id}`, { action: "approve", note: "again please" });
    expectStatus(approveAgain, 409, "approve a decided request");
    expect([`This request has already been decided.`]).toContain(message(approveAgain));
    const cancelAgain = await call(admin, "POST", `/api/admin/referral-moves/${id}`, { action: "cancel", note: "again please" });
    expectStatus(cancelAgain, 409, "cancel a decided request");
    expect(message(cancelAgain)).toBe("Only a waiting request can be cancelled.");
    return `${seen.join("; ")}; customer 403 on the letter; note “no” 422; cancelled from its card (“Request cancelled.”); approve again 409, cancel again 409`;
  });
}, { ...signed, partial: "Rejecting as Admin B and Admin B's 403 on another admin's cancel need a second staging admin (admin2's ADMIN role awaits the owner's approval)" });

qa("TC-REFM-005", "Referral moves at 375 px: no sideways scroll for either request kind, the form fields stack and the Requests list stays inside the screen", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin", { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  try {
    await page.goto("/admin/dealers/referral-moves");
    await expect(page.getByRole("heading", { name: "Referral moves" })).toBeVisible({ timeout: 60_000 });
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await sideways(), "shops form").toBeLessThanOrEqual(1);
    const card = page.getByTestId("referral-move-new");
    await card.getByRole("button", { name: "A team member with his code and shops" }).click();
    const a = need(await card.getByLabel("Current dealer / franchise").boundingBox(), "Current dealer");
    const b = need(await card.getByLabel("Team member to move").boundingBox(), "Team member");
    expect(b.y, "the member select is under the dealer select").toBeGreaterThan(a.y + a.height - 1);
    expect(await sideways(), "member form").toBeLessThanOrEqual(1);
    const last = page.getByTestId("referral-move-request").last();
    if (await last.count()) {
      await last.scrollIntoViewIfNeeded();
      const box = need(await last.boundingBox(), "a request card");
      expect(box.x + box.width).toBeLessThanOrEqual(376);
    }
    expect(await sideways(), "requests list").toBeLessThanOrEqual(1);
    return "375 px: both kinds without sideways scroll; selects stacked; request cards inside the screen";
  } finally {
    await context.close();
  }
}, { ...signed, partial: "Button heights are not measured; a pending request's missing-letters warning and opening a letter in a new tab are not checked (no pending request is left on staging)" });
