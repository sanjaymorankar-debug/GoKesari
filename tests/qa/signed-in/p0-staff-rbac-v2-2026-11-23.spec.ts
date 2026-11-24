/**
 * RBAC v2 staff roles and back office (docs/rbac; cases TC-STAFF-* added 23-Nov-2026), P0 cases of group R3,
 * as the staging staff accounts meet them on test.gokesari.com with all six rbac_v2_* flags ON (four-eye included):
 *
 *   gk-ops   (session "ops")   holds ACCOUNTANT, SUPPORT_MANAGER, OPERATIONS_MANAGER, SHOP_OWNER; normally acts as OPERATOR
 *   gk-oplim (session "oplim") holds CA, SUPPORT_USER, OPERATIONS_USER; normally acts as OPERATOR_LIMITED
 *
 * A check switches the role an account ACTS in (PUT /api/me/roles, roles it already holds — as the hand run of
 * 23-Nov 18.00 IST did, scripts/rbac/staging-flows.mjs) and puts both back in a finally block. No role is granted
 * or removed, no flag, rule or commission is changed.
 *
 * Test data it leaves (all marked "QA 23-Nov R3 <run>"):
 *   - ₹1.00, ₹49,999.99 and ₹50,000.00 journal entries, each POSTED and then REVERSED by an approved reversing entry
 *     (the pair nets to zero in the trial balance);
 *   - one bank statement (₹1.00 credit, ₹0.50 debit), RECONCILED — final by design;
 *   - a commission proposal of 4.50% that is CANCELLED after the CA's approval (never activated);
 *   - one role-change request (gk-ops → OPERATOR, its current role), CANCELLED by the admin who raised it;
 *   - support tickets on shop A / shop B, CLOSED at the end; shop change requests decided by shop A's owner;
 *     the product "Artificial Rose Garland – Single (5 ft)" of shop A gets its price back (₹99.00) and its
 *     shop-only MRP set back to the master MRP (₹99.00): the shop MRP row cannot be emptied again without the
 *     database, so it stays at the master's value.
 */
import type { Browser, Locator, Page, Route } from "@playwright/test";

import { as, me, pageAs, shopFreeCustomer } from "../lib/actors";
import { anonymous, call, clickWrite, expectStatus, RUN, SLOW_MS, stash, unstash, why, type Answer } from "../lib/http";
import { blocked, expect, qa, test } from "../lib/record";
import { world, type Role } from "../lib/world";

const KEY = "p0-staff-rbac-v2-2026-11-23";
const TAG = `QA 23-Nov R3 ${RUN}`;
/** The product of shop A this file changes (not bread, not a ₹45 / MRP ₹50 product: other runners use those). */
const PRODUCT = { shopProductId: "982151b4-cfa5-4ad9-b2cc-4cd3e5cd908e", name: "Artificial Rose Garland – Single (5 ft)" };
/** The Phool & Patte puja category of shop A, whose catalogue shows the product's master MRP. */
const PHOOL_PATTE = "24b3054a-93af-49da-87c2-4616fd6d0ec8";

type Staff = "ops" | "oplim";
/** The role each staff account acts in outside these checks (as found on 23-Nov and left by the hand run). */
const HOME: Record<Staff, string> = { ops: "OPERATOR", oplim: "OPERATOR_LIMITED" };

const istNow = () => new Date(Date.now() + 330 * 60_000);
const istDate = () => istNow().toISOString().slice(0, 10);
const istMonth = () => istDate().slice(0, 7);
const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const projectKey = (name: string) => `${KEY}:${test.info().project.name}:${name}`;

/* ------------------------------------------------------------------ roles */

/** gk-ops / gk-oplim act in `role` (one they already hold); blocked when they do not hold it. */
async function actAs(account: Staff, role: string) {
  const res = await call(await as(account), "PUT", "/api/me/roles", { role });
  if (res.status === 403) blocked(`gk-${account} does not hold ${role} (${why(res)})`);
  expectStatus(res, 200, `gk-${account} acts as ${role}`);
  expect(res.body.active, `gk-${account} acting as`).toBe(role);
}

/** Both staff accounts back on the role they act in outside these checks. */
async function restoreRoles() {
  for (const account of ["ops", "oplim"] as const) {
    const res = await call(await as(account), "PUT", "/api/me/roles", { role: HOME[account] }).catch(() => null);
    if (!res || res.status !== 200 || res.body?.active !== HOME[account]) {
      console.error(`[rbac-v2] gk-${account} could not be put back on ${HOME[account]}: ${res ? why(res) : "no answer"}`);
    }
  }
}

test.afterAll(async () => {
  await restoreRoles();
});

const FORBIDDEN = "You do not have permission to perform this action.";

function expectRefused(res: Answer, message: string, what: string) {
  expectStatus(res, 403, what);
  expect(res.body?.error?.message, what).toBe(message);
}

/** Where a page sends this caller: the redirect header, or the in-page redirect of a streamed page ("" when none). */
async function redirectOf(ctx: Awaited<ReturnType<typeof as>>, path: string): Promise<string> {
  const res = await call(ctx, "GET", path, undefined, { maxRedirects: 0 });
  if ([301, 302, 303, 307, 308].includes(res.status)) return new URL(res.location ?? "", "https://x").pathname;
  const meta = res.text.match(/http-equiv="refresh" content="\d+;url=([^"]+)"/)?.[1];
  if (meta) return new URL(meta.replace(/&amp;/g, "&"), "https://x").pathname;
  const nextRedirect = res.text.match(/NEXT_REDIRECT;[a-z]+;([^;"]+);/)?.[1];
  return nextRedirect ? new URL(nextRedirect, "https://x").pathname : "";
}

/* -------------------------------------------------------------- approvals */

interface ApprovalRequest {
  id: string;
  type: string;
  status: string;
  stage: number;
  checker: string;
  title: string;
  reason: string;
  shopId: string | null;
  requestedBy: string;
  appliedAt: string | null;
}

async function approval(id: string): Promise<{ request: ApprovalRequest; items: { id: string; field: string; status: string; rejectionComment: string | null }[] }> {
  const res = await call(await as("admin"), "GET", `/api/approvals/${id}`);
  expectStatus(res, 200, `approval ${id}`);
  return res.body;
}

async function pendingApprovals(): Promise<ApprovalRequest[]> {
  const res = await call(await as("admin"), "GET", "/api/approvals?status=PENDING");
  expectStatus(res, 200, "pending approvals");
  return res.body as ApprovalRequest[];
}

async function decide(account: Role, id: string, decision: "APPROVE" | "REJECT", comment?: string) {
  return call(await as(account), "POST", `/api/approvals/${id}/decide`, { decision, comment: comment ?? null });
}

/** The card of one request in an approvals queue (Admin → Approvals, or the CA's "To approve" tab). */
function approvalCard(page: Page, title: string) {
  return page.getByTestId("approvals-queue").locator(":scope > *").filter({ hasText: title });
}

/**
 * Clicks a button that decides a request and returns the answer and whether the card's message was seen. The page
 * refreshes right after the answer, which takes the decided card (and its message) away: the refresh (an RSC
 * request) is held back 4 s so the message can be read, and the wait for it starts before the click.
 */
async function clickDecision(page: Page, button: Locator, requestId: string, message: string) {
  const hold = async (route: Route) => {
    if (route.request().headers()["rsc"] === "1") await new Promise((r) => setTimeout(r, 4_000));
    await route.continue().catch(() => {});
  };
  await page.route("**/*", hold);
  try {
    const seen = page
      .getByText(message, { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: SLOW_MS })
      .then(() => true, () => false);
    const res = await clickWrite(page, button, `/api/approvals/${requestId}`, "POST");
    return { status: res.status(), body: (await res.json().catch(() => null)) as { applied?: boolean; applyError?: string | null; error?: { message?: string } } | null, seen: await seen };
  } finally {
    await page.unroute("**/*", hold);
  }
}

/* ---------------------------------------------------------------- journals */

interface Entry {
  id: string;
  entryNumber: string;
  status: string;
  narration: string;
  totalPaise: number;
  approvalRequestId: string | null;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
}
interface Line {
  accountCode: string;
  accountName: string;
  debitPaise: number;
  creditPaise: number;
}

async function journal(id: string): Promise<{ entry: Entry; lines: Line[] }> {
  const res = await call(await as("ops"), "GET", `/api/staff/accounting/journals/${id}`);
  expectStatus(res, 200, `journal ${id}`);
  return res.body;
}

/** As the Accountant (gk-ops must act as ACCOUNTANT): a balanced two-line draft. */
async function draftJournal(narration: string, paise: number, accounts: [string, string, string, string]) {
  const res = await call(await as("ops"), "POST", "/api/staff/accounting/journals", {
    entryDate: istDate(),
    narration,
    lines: [
      { accountCode: accounts[0], accountName: accounts[1], debitPaise: paise },
      { accountCode: accounts[2], accountName: accounts[3], creditPaise: paise },
    ],
  });
  expectStatus(res, 201, `draft ${narration}`);
  return res.body as Entry;
}

async function submitJournal(id: string): Promise<Entry> {
  const res = await call(await as("ops"), "POST", `/api/staff/accounting/journals/${id}/submit`);
  expectStatus(res, 200, "submit the entry");
  return res.body as Entry;
}

async function trialBalance(): Promise<Map<string, { debitPaise: number; creditPaise: number; balancePaise: number }>> {
  const res = await call(await as("ops"), "GET", "/api/staff/accounting/trial-balance");
  expectStatus(res, 200, "trial balance");
  return new Map((res.body.rows as { accountCode: string; debitPaise: number; creditPaise: number; balancePaise: number }[]).map((r) => [r.accountCode, r]));
}

/**
 * Reverses a POSTED entry the way the books are corrected (reversing draft → submit → CA → admin when high value)
 * and returns what happened. gk-ops acts as ACCOUNTANT and gk-oplim as CA while it runs. Never throws.
 */
async function reverseFully(entryId: string, reason: string): Promise<string> {
  try {
    await actAs("ops", "ACCOUNTANT");
    await actAs("oplim", "CA");
    const { entry } = await journal(entryId);
    if (entry.status === "SUBMITTED") {
      const w = await call(await as("ops"), "POST", `/api/staff/accounting/journals/${entryId}/withdraw`);
      return `${entry.entryNumber} was still SUBMITTED: withdrawn to DRAFT (${w.status}); a draft cannot be deleted`;
    }
    if (entry.status !== "POSTED") return `${entry.entryNumber} is ${entry.status}: nothing to reverse`;
    const draft = await call(await as("ops"), "POST", `/api/staff/accounting/journals/${entryId}/reverse`, { entryDate: istDate(), reason });
    expectStatus(draft, 201, "reversing draft");
    const submitted = await submitJournal(draft.body.id);
    const ca = await decide("oplim", submitted.approvalRequestId!, "APPROVE");
    expectStatus(ca, 200, "CA approves the reversal");
    if (!ca.body.applied) {
      const admin = await decide("admin", submitted.approvalRequestId!, "APPROVE");
      expectStatus(admin, 200, "admin approves the high-value reversal");
    }
    const after = (await journal(entryId)).entry;
    return `${entry.entryNumber} ${after.status} by ${draft.body.entryNumber}`;
  } catch (error) {
    return `reversal of ${entryId} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
}

/* --------------------------------------------------------------- audit log */

/** The newest 100 audit rows as Admin → Console → Audit log shows them (one text per row). */
async function auditRows(browser: Browser): Promise<string[]> {
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/console/audit-log");
    const rows = page.getByRole("row");
    await expect(rows.nth(1)).toBeVisible();
    return await rows.allInnerTexts();
  } finally {
    await context.close();
  }
}

/* ----------------------------------------------------------------- support */

interface Ticket {
  id: string;
  ticketNumber: string;
}

/** gk-ops, acting as Support Manager, raises a ticket about `shopId` and assigns it to `assigneeId`. */
async function raiseTicket(shopId: string, subject: string, assigneeId: string): Promise<Ticket> {
  await actAs("ops", "SUPPORT_MANAGER");
  const ops = await as("ops");
  const res = await call(ops, "POST", "/api/staff/support/tickets", {
    shopId,
    category: "PRICE_UPDATE",
    subject,
    description: `${TAG}: staging test ticket for the RBAC v2 checks; closed by the check that raised it.`,
    priority: "NORMAL",
  });
  expectStatus(res, 201, "raise a ticket");
  const assigned = await call(ops, "PATCH", `/api/staff/support/tickets/${res.body.id}`, { assigneeId, note: "QA assign" });
  expectStatus(assigned, 200, "assign the ticket");
  return { id: res.body.id, ticketNumber: res.body.ticketNumber };
}

async function ticketStatus(id: string): Promise<string> {
  const res = await call(await as("admin"), "GET", `/api/support/tickets/${id}`);
  expectStatus(res, 200, `ticket ${id}`);
  return res.body.ticket.status as string;
}

/** Resolves and closes a test ticket (gk-ops as Support Manager). Never throws. */
async function closeTicket(id: string | undefined): Promise<string> {
  if (!id) return "";
  try {
    await actAs("ops", "SUPPORT_MANAGER");
    const ops = await as("ops");
    let status = await ticketStatus(id);
    if (status !== "RESOLVED" && status !== "CLOSED") {
      const r = await call(ops, "PATCH", `/api/support/tickets/${id}`, { action: "status", status: "RESOLVED", note: `${TAG}: test ticket closed by the check` });
      expectStatus(r, 200, "resolve the test ticket");
    }
    status = await ticketStatus(id);
    if (status === "RESOLVED") expectStatus(await call(ops, "POST", `/api/staff/support/tickets/${id}/confirm`, { note: "QA test ticket" }), 200, "close the test ticket");
    return await ticketStatus(id);
  } catch (error) {
    return `not closed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
}

/** Shop A's product as a customer sees it (price and the MRP shown, shop MRP first). */
async function liveProduct(shopId: string): Promise<{ onlinePricePaise: number; mrpPaise: number | null }> {
  for (let offset = 0; offset < 1000; offset += 100) {
    const res = await call(await as("customer"), "GET", `/api/shops/${shopId}/products?limit=100&offset=${offset}`);
    expectStatus(res, 200, "shop A's shelf");
    const rows = res.body as { shopProductId: string; onlinePricePaise: number; mrpPaise: number | null }[];
    const row = rows.find((r) => r.shopProductId === PRODUCT.shopProductId);
    if (row) return row;
    if (rows.length < 100) break;
  }
  blocked(`shop A no longer sells "${PRODUCT.name}" online`);
}

/** The product's master MRP (Product master), read from shop A's puja catalogue. */
async function masterMrp(shopId: string): Promise<number | null> {
  const res = await call(await as("shop"), "GET", `/api/shops/${shopId}/puja/catalogue?limit=200&categoryId=${PHOOL_PATTE}`);
  expectStatus(res, 200, "puja catalogue");
  const item = (res.body.items as { listing: { id: string } | null; mrpPaise: number | null }[]).find((i) => i.listing?.id === PRODUCT.shopProductId);
  return item ? item.mrpPaise : null;
}

async function shopDescription(shopId: string): Promise<string | null> {
  const res = await call(await as("shop"), "GET", `/api/shops/${shopId}`);
  expectStatus(res, 200, "shop A as its owner sees it");
  return (res.body.description as string | null) ?? null;
}

/** As the Support User (gk-oplim must act as SUPPORT_USER): one change request on shop A from a ticket. */
async function propose(shopId: string, ticketId: string, reason: string, items: unknown[]): Promise<Answer> {
  return call(await as("oplim"), "POST", `/api/staff/shops/${shopId}/changes`, { ticketId, reason, items });
}

async function notificationsOf(role: Role): Promise<{ title: string; body: string; actionUrl: string | null; dedupeKey: string | null }[]> {
  const res = await call(await as(role), "GET", "/api/notifications");
  expectStatus(res, 200, "notifications");
  return res.body.notifications;
}

function shopA() {
  const shop = world().shops.A;
  if (!shop?.id) blocked("needs shop A of the staging world");
  return shop as { id: string; name: string };
}

/* ============================================================== accounting */

qa("TC-STAFF-002", "the Accountant is only the maker and the CA only the checker: rate set, period close, journal and rate proposal are refused; Finance opens read-only for the Accountant", async ({ browser }) => {
  const ops = await me("ops");
  const before = await call(await as("admin"), "GET", "/api/finance/commission-rates");
  expectStatus(before, 200, "commission rates");
  const pendingBefore = new Set((await pendingApprovals()).map((r) => r.id));
  const month = istMonth();
  const notes: string[] = [];
  try {
    await actAs("ops", "ACCOUNTANT");
    await actAs("oplim", "CA");
    const rate = await call(await as("ops"), "POST", "/api/finance/commission-rates", { scope: "DEFAULT", rateBp: 500 });
    if (rate.status === 202) await call(await as("ops"), "POST", `/api/approvals/${rate.body.approvalId}/cancel`, { comment: "QA: refused-check cleanup" });
    expectRefused(rate, FORBIDDEN, "1. Accountant sets the default commission");
    const close = await call(await as("ops"), "POST", `/api/staff/accounting/periods/${month}`, { action: "CLOSE" });
    if (close.status === 200) {
      const reopen = await call(await as("oplim"), "POST", `/api/staff/accounting/periods/${month}`, { action: "REOPEN", reason: `${TAG}: closed by a check that expected a refusal` });
      notes.push(`period ${month} was CLOSED by the Accountant and reopened by the CA (${reopen.status})`);
    }
    expectRefused(close, FORBIDDEN, "2. Accountant closes the month");
    const draft = await call(await as("oplim"), "POST", "/api/staff/accounting/journals", {
      entryDate: istDate(),
      narration: `${TAG} CA may not prepare`,
      lines: [
        { accountCode: "1010", accountName: "QA bank", debitPaise: 100 },
        { accountCode: "4990", accountName: "QA income", creditPaise: 100 },
      ],
    });
    expectRefused(draft, FORBIDDEN, "3. CA drafts a journal entry");
    const live = (before.body as { scope: string; isActive: boolean; rateBp: number }[]).find((r) => r.scope === "DEFAULT" && r.isActive);
    // Same rate, years ahead: harmless even if it were accepted.
    const propose = await call(await as("oplim"), "POST", "/api/staff/accounting/rates", {
      rateKind: "COMMISSION",
      scope: "DEFAULT",
      rateBp: live?.rateBp ?? 100,
      effectiveAt: "2030-01-01T00:00:00+05:30",
      reason: `${TAG} CA may not propose`,
    });
    expectRefused(propose, FORBIDDEN, "4. CA proposes a commission change");

    const after = await call(await as("admin"), "GET", "/api/finance/commission-rates");
    expect(after.body, "commission rates unchanged").toEqual(before.body);
    const created = (await pendingApprovals()).filter((r) => !pendingBefore.has(r.id) && r.requestedBy === ops.id);
    expect(created.map((r) => r.title), "no request raised by the refused calls").toEqual([]);
    const periods = await call(await as("oplim"), "GET", "/api/staff/accounting/periods");
    expectStatus(periods, 200, "periods");
    const period = (periods.body as { code: string; status: string }[]).find((p) => p.code === month);
    expect(period?.status ?? "OPEN", `period ${month}`).toBe("OPEN");

    const { context, page } = await pageAs(browser, "ops");
    try {
      await page.goto("/admin/finance");
      await expect(page).toHaveURL(/\/admin\/finance$/);
      await expect(page.getByRole("heading", { name: "Finance", exact: true })).toBeVisible();
      const tabs = page.getByRole("tablist", { name: "Finance sections" });
      await expect(tabs.getByRole("tab", { name: "Settlements", exact: true })).toBeVisible();
      await expect(tabs.getByRole("tab", { name: "Refund an order" }), "no refund section").toHaveCount(0);
      // The sections are tabs: each is opened, so a control in a hidden panel is not missed.
      for (const tab of ["Owed now", "Commission", "Settlements", "Rider payouts", "Adjustments"]) {
        await tabs.getByRole("tab", { name: tab, exact: true }).click();
        const panel = page.getByRole("tabpanel", { name: tab, exact: true });
        await expect(panel).toBeVisible();
        await expect(panel.getByRole("button"), `no control in “${tab}” (prepare, approve, send to bank, mark paid, rate, adjustment)`).toHaveCount(0);
      }
      await tabs.getByRole("tab", { name: "Reconciliation", exact: true }).click();
      const recon = page.getByRole("tabpanel", { name: "Reconciliation", exact: true });
      await expect(recon).toBeVisible();
      await expect(recon.getByRole("button", { name: /Run reconciliation/ })).toHaveCount(0);
      const resolve = await recon.getByRole("button", { name: "Resolve", exact: true }).count();
      if (resolve) notes.push(`note: ${resolve} reconciliation “Resolve” button(s) are shown to the Accountant (FINANCE_VIEW may resolve records)`);
    } finally {
      await context.close();
    }
  } finally {
    await restoreRoles();
  }
  return ["1–4 refused with 403 “You do not have permission to perform this action.”; nothing created, commission and period unchanged; /admin/finance opens read-only: no refund tab and no control in Owed now, Commission, Settlements, Rider payouts, Adjustments; no “Run reconciliation”", ...notes].join("; ");
}, { tier: "signed", partial: "the authz.denied rows of these refusals are checked in TC-STAFF-003 only" });

qa("TC-STAFF-003", "Support User and Support Manager cannot write shop data or change roles; each refusal is logged as authz.denied", async ({ browser }) => {
  const shop = shopA();
  const oplim = await me("oplim");
  const descBefore = await shopDescription(shop.id);
  const rolesBefore = (await call(await as("oplim"), "GET", "/api/me/roles")).body.roles as string[];
  try {
    await actAs("oplim", "SUPPORT_USER");
    await actAs("ops", "SUPPORT_MANAGER");
    expectRefused(await call(await as("oplim"), "PATCH", `/api/shops/${shop.id}`, { description: "QA" }), "This shop does not belong to you.", "1. Support User edits shop A");
    expect(await redirectOf(await as("oplim"), "/admin/support"), "2. Support User opens the full queue").toBe("/");
    expectRefused(await call(await as("ops"), "PATCH", `/api/shops/${shop.id}`, { description: "QA" }), "This shop does not belong to you.", "3. Support Manager edits shop A");
    expectRefused(await call(await as("ops"), "PATCH", `/api/users/${oplim.id}/role`, { role: "OPERATOR" }), FORBIDDEN, "4. Support Manager changes a role");

    expect(await shopDescription(shop.id), "shop A's description").toBe(descBefore);
    const rolesAfter = (await call(await as("oplim"), "GET", "/api/me/roles")).body;
    expect(rolesAfter.active, "gk-oplim's role").toBe("SUPPORT_USER");
    expect([...rolesAfter.roles].sort(), "gk-oplim's roles").toEqual([...rolesBefore].sort());

    const rows = await auditRows(browser);
    const denied = rows.filter((r) => r.includes("authz.denied"));
    expect(denied.some((r) => r.includes("SUPPORT_USER") && r.includes(shop.id)), "authz.denied row for the Support User's shop edit").toBe(true);
    expect(denied.some((r) => r.includes("SUPPORT_MANAGER") && r.includes(shop.id)), "authz.denied row for the Support Manager's shop edit").toBe(true);
    expect(denied.some((r) => r.includes("SUPPORT_MANAGER") && r.includes("user:set-role")), "authz.denied row for the role change").toBe(true);
  } finally {
    if ((await shopDescription(shop.id).catch(() => descBefore)) !== descBefore) {
      await call(await as("shop"), "PATCH", `/api/shops/${shop.id}`, { description: descBefore });
    }
    await restoreRoles();
  }
  return "shop edits → 403 “This shop does not belong to you.” (Support User and Manager); /admin/support → /; role change → 403; shop and roles unchanged; three authz.denied rows on Admin → Audit log";
}, { tier: "signed" });

qa("TC-STAFF-023", "nobody approves their own request: Admin A's role change waits (202), his card offers only Cancel, and his approval is refused", async ({ browser }) => {
  const ops = await me("ops");
  await restoreRoles(); // the subject acts as OPERATOR, so the requested role equals the current one: harmless if a second admin approved it
  const before = (await call(await as("ops"), "GET", "/api/me/roles")).body;
  expect(before.active, "gk-ops acts as").toBe("OPERATOR");
  let approvalId: string | null = null;
  let cancelled = "";
  try {
    const res = await call(await as("admin"), "PATCH", `/api/users/${ops.id}/role`, { role: "OPERATOR" });
    expectStatus(res, 202, "1. Admin A sets a role (four-eye ON)");
    expect(res.body.pendingApproval).toBe(true);
    approvalId = res.body.approvalId as string;
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/);
    const after = (await call(await as("ops"), "GET", "/api/me/roles")).body;
    expect(after, "the role is unchanged").toEqual(before);
    expect((await approval(approvalId)).request.status).toBe("PENDING");

    const { context, page } = await pageAs(browser, "admin");
    try {
      await page.goto("/admin/approvals");
      const cards = approvalCard(page, "Set role to OPERATOR").filter({ hasText: "Your request" });
      await expect(cards.first(), "2. Admin A's card").toBeVisible();
      const adminId = (await me("admin")).id;
      const mine = (await pendingApprovals()).filter((r) => r.type === "USER_ROLE_SET" && r.title === "Set role to OPERATOR" && r.requestedBy === adminId);
      await expect(cards, "one card per request of Admin A").toHaveCount(mine.length);
      const card = cards.first();
      await expect(card.getByRole("button", { name: "Cancel request" })).toBeVisible();
      await expect(card.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Reject" })).toHaveCount(0);

      const self = await decide("admin", approvalId, "APPROVE");
      expectStatus(self, 403, "3. Admin A approves his own request");
      expect(["A different admin must approve this request.", "A different admin must approve this request (two admins are active)."]).toContain(self.body?.error?.message);
      expect((await approval(approvalId)).request.status, "still waiting").toBe("PENDING");

      if (mine.length === 1) {
        const done = page.getByText("Request cancelled.").waitFor({ state: "visible", timeout: SLOW_MS }).then(() => true, () => false);
        const res2 = await clickWrite(page, card.getByRole("button", { name: "Cancel request" }), `/api/approvals/${approvalId}/cancel`, "POST");
        expect(res2.status(), "cancel").toBe(200);
        cancelled = (await done) ? "cancelled on the card (“Request cancelled.”)" : "cancelled on the card";
      }
    } finally {
      await context.close();
    }
  } finally {
    if (approvalId && (await approval(approvalId).catch(() => null))?.request.status === "PENDING") {
      const c = await call(await as("admin"), "POST", `/api/approvals/${approvalId}/cancel`, { comment: `${TAG}: test request, cancelled by the admin who raised it` });
      cancelled = c.status === 200 ? "cancelled by the requester (API)" : `NOT cancelled: ${why(c)} — request ${approvalId} still pending`;
    }
  }
  const final = approvalId ? (await approval(approvalId)).request : null;
  expect(final?.appliedAt ?? null, "never applied").toBeNull();
  return `202 with approval ${approvalId}; role unchanged; card “Your request” with only “Cancel request”; self-approval → 403 “A different admin must approve this request.”; request ${final?.status} (${cancelled})`;
}, { tier: "signed", partial: "the subject (gk-ops) already acts as OPERATOR, so “role unchanged” is shown by the request staying unapplied; the Super Admin variant of the message is not run (no Super Admin session)" });

qa("TC-STAFF-033", "the Accountant drafts and submits a balanced ₹1.00 journal entry; the CA's To approve lists it", async ({ browser }) => {
  const narration = `${TAG} receipt`;
  stash(`${KEY}:entry`, null);
  try {
    await actAs("ops", "ACCOUNTANT");
    await actAs("oplim", "CA");
    let entryNumber = "";
    const { context, page } = await pageAs(browser, "ops");
    try {
      await page.goto("/staff/accounting");
      await expect(page.getByText("New journal entry")).toBeVisible();
      await expect(page.getByLabel("Entry date")).toHaveValue(istDate());
      await page.getByLabel("Narration").fill(narration);
      await page.getByLabel("Line 1 account code").fill("1010");
      await page.getByLabel("Line 1 account name").fill("QA bank");
      await page.getByLabel("Line 1 debit").fill("1");
      await page.getByLabel("Line 2 account code").fill("4990");
      await page.getByLabel("Line 2 account name").fill("QA income");
      await page.getByLabel("Line 2 credit").fill("1");
      const running = page.getByText("Debits ₹1.00 · Credits ₹1.00", { exact: true });
      await expect(running).toBeVisible();
      await expect(running, "balanced: shown in green").toHaveClass(/text-leaf-700/);
      const saved = await clickWrite(page, page.getByRole("button", { name: "Save draft" }), "/api/staff/accounting/journals", "POST");
      expect(saved.status(), "save draft").toBe(201);
      const entry = (await saved.json()) as Entry;
      entryNumber = entry.entryNumber;
      stash(`${KEY}:entry`, { id: entry.id, entryNumber, narration });
      await expect(page.getByText(`${entryNumber} saved as a draft.`, { exact: true })).toBeVisible();
      const card = page.getByText(entryNumber, { exact: true }).locator("xpath=../..");
      await expect(card.getByText("DRAFT", { exact: true })).toBeVisible();
      await expect(card).toContainText("₹1.00");
      const sub = await clickWrite(page, card.getByRole("button", { name: "Submit", exact: true }), `/api/staff/accounting/journals/${entry.id}/submit`, "POST");
      expect(sub.status(), "submit").toBe(200);
      await expect(card.getByText("SUBMITTED", { exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: "Withdraw" })).toBeVisible();
    } finally {
      await context.close();
    }
    const stored = unstash<{ id: string }>(`${KEY}:entry`)!;
    const { entry } = await journal(stored.id);
    expect(entry.status).toBe("SUBMITTED");
    expect(entry.totalPaise).toBe(100);
    stash(`${KEY}:entry`, { id: entry.id, entryNumber, narration, requestId: entry.approvalRequestId });

    const ca = await pageAs(browser, "oplim");
    try {
      await ca.page.goto("/staff/accounting?tab=approvals");
      await expect(approvalCard(ca.page, `${entryNumber}: ${narration} (₹1.00)`)).toHaveCount(1);
    } finally {
      await ca.context.close();
    }
    const rows = await auditRows(browser);
    expect(rows.some((r) => r.includes("fin_journal.drafted") && r.includes(entryNumber)), "audit fin_journal.drafted").toBe(true);
    return `${entryNumber} “${narration}”: Debits ₹1.00 · Credits ₹1.00 (green) → saved as a draft (DRAFT ₹1.00) → SUBMITTED with Withdraw; on the CA's To approve; audit fin_journal.drafted`;
  } finally {
    await restoreRoles();
  }
}, { tier: "signed", partial: "“the existing finance ledger is not written” needs database access" });

qa("TC-STAFF-035", "the CA posts the entry; the Accountant cannot approve it", async ({ browser }) => {
  const stored = unstash<{ id: string; entryNumber: string; narration: string; requestId: string }>(`${KEY}:entry`);
  if (!stored?.requestId) blocked("needs the submitted ₹1.00 entry of TC-STAFF-033");
  try {
    await actAs("ops", "ACCOUNTANT");
    await actAs("oplim", "CA");
    const { entry } = await journal(stored.id);
    if (entry.status !== "SUBMITTED") blocked(`the entry of TC-STAFF-033 is ${entry.status}, not SUBMITTED`);
    expectRefused(await decide("ops", stored.requestId, "APPROVE"), "Only a CA can decide this request.", "1. the Accountant approves");
    const tb = await trialBalance();
    stash(`${KEY}:tb0`, { "1010": tb.get("1010")?.balancePaise ?? 0, "4990": tb.get("4990")?.balancePaise ?? 0 });

    const ca = await pageAs(browser, "oplim");
    try {
      await ca.page.goto("/staff/accounting?tab=approvals");
      const title = `${stored.entryNumber}: ${stored.narration} (₹1.00)`;
      const card = approvalCard(ca.page, title);
      await expect(card).toHaveCount(1);
      const res = await clickDecision(ca.page, card.getByRole("button", { name: "Approve", exact: true }), stored.requestId, "Approved and applied.");
      expect(res.status, "2. CA approves").toBe(200);
      expect(res.body?.applied, "applied").toBe(true);
      expect(res.seen, "“Approved and applied.” shown").toBe(true);
      await expect(approvalCard(ca.page, title), "the card leaves the list").toHaveCount(0);
    } finally {
      await ca.context.close();
    }
    const acc = await pageAs(browser, "ops");
    try {
      await acc.page.goto("/staff/accounting");
      const card = acc.page.getByText(stored.entryNumber, { exact: true }).locator("xpath=../..");
      await expect(card.getByText("POSTED", { exact: true }), "3. the Accountant sees it POSTED").toBeVisible();
    } finally {
      await acc.context.close();
    }
    expect((await journal(stored.id)).entry.status).toBe("POSTED");
    const rows = await auditRows(browser);
    expect(rows.some((r) => r.includes("fin_journal.posted") && r.includes(stored.entryNumber)), "audit fin_journal.posted").toBe(true);
    return `Accountant → 403 “Only a CA can decide this request.”; CA Approve → “Approved and applied.”, card gone; ${stored.entryNumber} POSTED; audit fin_journal.posted`;
  } finally {
    await restoreRoles();
  }
}, { tier: "signed", partial: "step 4 (one user holding both Accountant and CA approves own entry → 403 “You cannot approve your own request.”) is blocked: no staging account holds both roles and granting roles is not allowed" });

qa("TC-STAFF-050", "match, exclude, submit; the CA signs the statement off and it is final", async ({ browser }) => {
  const stored = unstash<{ id: string; entryNumber: string }>(`${KEY}:entry`);
  if (!stored) blocked("needs the posted ₹1.00 journal entry of TC-STAFF-033 / 035");
  let statementId: string | undefined;
  try {
    await actAs("ops", "ACCOUNTANT");
    await actAs("oplim", "CA");
    if ((await journal(stored.id)).entry.status !== "POSTED") blocked(`the ₹1.00 entry ${stored.entryNumber} is not POSTED`);
    // The statement of TC-STAFF-046: opening balance, a ₹1.00 credit and a ₹0.50 debit.
    const day = istDate().split("-").reverse().join("/");
    const runTag = RUN.toUpperCase();
    const csv = [
      "Date,Narration,Ref No,Debit,Credit,Balance",
      "Opening Balance,,,,,1000.00",
      `${day},QA 23-Nov R3 ${runTag} RECEIPT,QA23NOV${runTag},,1.00,1001.00`,
      `${day},QA 23-Nov R3 ${runTag} SMS CHARGES,,0.50,,1000.50`,
    ].join("\n");
    const accountLabel = `QA 23-Nov R3 ${RUN.replace(/\d/g, "")} ••0000`;
    const imported = await call(await as("ops"), "POST", "/api/staff/accounting/bank-statements", undefined, {
      multipart: { file: { name: `qa-23nov-r3-${RUN}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) }, accountLabel },
    });
    expectStatus(imported, 201, "import the statement");
    const statement = imported.body.statement as { id: string; statementNumber: string };
    statementId = statement.id;
    stash(`${KEY}:statement`, statement);
    const url = `/staff/accounting?tab=bank&statement=${statement.id}`;

    const { context, page } = await pageAs(browser, "ops");
    try {
      await page.goto(url);
      const line = (n: number) => page.getByText(`#${n}`, { exact: true }).locator("xpath=../..");
      await line(1).getByRole("button", { name: "Find match / exclude" }).click();
      const search = page.getByLabel("Search records");
      await search.fill(stored.entryNumber);
      await search.locator("xpath=..").getByRole("button", { name: "Search", exact: true }).click();
      const candidate = page.getByText(new RegExp(`${stored.entryNumber}: `)).locator("xpath=..");
      const matched = await clickWrite(page, candidate.getByRole("button", { name: "Match", exact: true }), "/api/staff/accounting/bank-lines/", "POST");
      expect(matched.status(), "1. match the ₹1.00 credit").toBe(200);
      await expect(page.getByText("Line 1 matched.")).toBeVisible();
      await expect(line(1)).toContainText(`→ ${stored.entryNumber}`);
      await line(2).getByRole("button", { name: "Find match / exclude" }).click();
      await page.getByLabel("Reason to exclude").fill("QA bank SMS charges");
      const excluded = await clickWrite(page, page.getByRole("button", { name: "Exclude", exact: true }), "/api/staff/accounting/bank-lines/", "POST");
      expect(excluded.status(), "2. exclude the ₹0.50 debit").toBe(200);
      await expect(page.getByText("Line 2 excluded.")).toBeVisible();
      await expect(page.locator("p").filter({ hasText: /\d+ matched · \d+ excluded · \d+ unmatched/ })).toHaveText("1 matched · 1 excluded · 0 unmatched");
      const submitted = await clickWrite(page, page.getByRole("button", { name: "Submit to CA" }), `/api/staff/accounting/bank-statements/${statement.id}/submit`, "POST");
      expect(submitted.status(), "3. submit to the CA").toBe(200);
      await expect(page.getByText("Sent to the CA for sign-off.")).toBeVisible();
    } finally {
      await context.close();
    }
    const view = await call(await as("ops"), "GET", `/api/staff/accounting/bank-statements/${statement.id}`);
    expect(view.body.statement.status).toBe("SUBMITTED");
    const again = await call(await as("ops"), "POST", `/api/staff/accounting/bank-statements/${statement.id}/auto-match`);
    expectStatus(again, 409, "4. match again while with the CA");
    expect(again.body.error.message).toBe("This statement is with the CA. Withdraw it to change it.");

    const ca = await pageAs(browser, "oplim");
    let csvName = "";
    let csvHead = "";
    try {
      await ca.page.goto("/staff/accounting?tab=approvals");
      const card = approvalCard(ca.page, `${statement.statementNumber}:`);
      await expect(card).toHaveCount(1);
      const res = await clickDecision(ca.page, card.getByRole("button", { name: "Approve", exact: true }), view.body.statement.approvalRequestId, "Approved and applied.");
      expect(res.status, "5. the CA approves").toBe(200);
      expect(res.body?.applied).toBe(true);
      await ca.page.goto(url);
      await expect(ca.page.getByText("RECONCILED", { exact: true }).first()).toBeVisible();
      const download = ca.page.waitForEvent("download", { timeout: SLOW_MS });
      await ca.page.getByRole("link", { name: "Download CSV" }).click();
      const file = await download;
      csvName = file.suggestedFilename();
      const stream = await file.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      csvHead = Buffer.concat(chunks).toString("utf8").split("\n")[0];
    } finally {
      await ca.context.close();
    }
    expect(csvName, "6. CSV file name").toBe(`${statement.statementNumber}-reconciliation.csv`);
    expect(csvHead).toBe("line,date,value_date,description,reference,debit_inr,credit_inr,balance_inr,status,matched_to,note");
    const final = await call(await as("oplim"), "GET", `/api/staff/accounting/bank-statements/${statement.id}`);
    expect(final.body.statement.status).toBe("RECONCILED");
    const del = await call(await as("ops"), "DELETE", `/api/staff/accounting/bank-statements/${statement.id}`);
    expectStatus(del, 409, "7. delete a reconciled statement");
    expect(del.body.error.message).toBe("This statement is reconciled and final.");
    const rows = await auditRows(browser);
    expect(rows.some((r) => r.includes("fin_bank_statement.reconciled") && r.includes(statement.id.slice(0, 8))), "audit fin_bank_statement.reconciled").toBe(true);
    return `${statement.statementNumber}: ₹1.00 credit → ${stored.entryNumber}, ₹0.50 excluded; “1 matched · 1 excluded · 0 unmatched”; “Sent to the CA for sign-off.”; auto-match → 409; CA → RECONCILED (audit); ${csvName} with the header; DELETE → 409 “This statement is reconciled and final.”`;
  } finally {
    // A statement left OPEN or SUBMITTED by a failed run is withdrawn and deleted (its matches are released).
    if (statementId) {
      const left = await call(await as("ops"), "GET", `/api/staff/accounting/bank-statements/${statementId}`).catch(() => null);
      const status = left?.body?.statement?.status as string | undefined;
      if (status === "SUBMITTED") await call(await as("ops"), "POST", `/api/staff/accounting/bank-statements/${statementId}/withdraw`);
      if (status === "SUBMITTED" || status === "OPEN") {
        const del = await call(await as("ops"), "DELETE", `/api/staff/accounting/bank-statements/${statementId}`);
        console.log(`[TC-STAFF-050] test statement ${statementId} was ${status}: deleted (${del.status})`);
      }
    }
    await restoreRoles();
  }
}, { tier: "signed", partial: "the database refusal of edits (“fin_bank_statements: a reconciled statement is final”) needs database access" });

qa("TC-STAFF-038", "posted entries are final; a correction is a reversing entry that nets to zero", async ({ browser }) => {
  const stored = unstash<{ id: string; entryNumber: string }>(`${KEY}:entry`);
  if (!stored) blocked("needs the posted ₹1.00 entry of TC-STAFF-033 / 035");
  const reason = "Posted to wrong month";
  try {
    await actAs("ops", "ACCOUNTANT");
    await actAs("oplim", "CA");
    const original = await journal(stored.id);
    if (original.entry.status !== "POSTED") blocked(`${stored.entryNumber} is ${original.entry.status}, not POSTED`);
    const tbBefore = await trialBalance();
    const reversalNarration = `Reversal of ${stored.entryNumber}: ${reason}`;
    const findReversal = async () => {
      const res = await call(await as("ops"), "GET", "/api/staff/accounting/journals");
      return (res.body as Entry[]).find((e) => e.reversesEntryId === stored.id);
    };

    const { context, page } = await pageAs(browser, "ops");
    let reversal: Entry | undefined;
    try {
      await page.goto("/staff/accounting");
      const card = (n: string) => page.getByText(n, { exact: true }).locator("xpath=../..");
      // A reason under 5 characters is refused.
      page.once("dialog", (d) => void d.accept("abc"));
      const short = await clickWrite(page, card(stored.entryNumber).getByRole("button", { name: "Reverse" }), `/api/staff/accounting/journals/${stored.id}/reverse`, "POST");
      expect(short.status(), "reason “abc”").toBe(422);
      await expect(card(stored.entryNumber).getByText("Done.")).toHaveCount(0);
      expect(await findReversal(), "no reversal drafted for a short reason").toBeUndefined();

      page.once("dialog", (d) => void d.accept(reason));
      const made = await clickWrite(page, card(stored.entryNumber).getByRole("button", { name: "Reverse" }), `/api/staff/accounting/journals/${stored.id}/reverse`, "POST");
      expect(made.status(), "2. reverse").toBe(201);
      reversal = (await made.json()) as Entry;
      await expect(page.getByText(reversalNarration, { exact: true })).toBeVisible();
      await expect(card(reversal.entryNumber).getByText("DRAFT", { exact: true })).toBeVisible();

      page.once("dialog", (d) => void d.accept(reason));
      const twice = await clickWrite(page, card(stored.entryNumber).getByRole("button", { name: "Reverse" }), `/api/staff/accounting/journals/${stored.id}/reverse`, "POST");
      expect(twice.status(), "3. reverse again").toBe(409);
      await expect(card(stored.entryNumber).getByText("A reversal of this entry is already being prepared.")).toBeVisible();

      const sub = await clickWrite(page, card(reversal.entryNumber).getByRole("button", { name: "Submit", exact: true }), `/api/staff/accounting/journals/${reversal.id}/submit`, "POST");
      expect(sub.status(), "4. submit the reversal").toBe(200);
      await expect(card(reversal.entryNumber).getByText("SUBMITTED", { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
    const rev = await journal(reversal!.id);
    expect(rev.entry.narration).toBe(reversalNarration);
    const swapped = original.lines.map((l) => ({ accountCode: l.accountCode, debitPaise: l.creditPaise, creditPaise: l.debitPaise }));
    expect(rev.lines.map((l) => ({ accountCode: l.accountCode, debitPaise: l.debitPaise, creditPaise: l.creditPaise })), "debits and credits swapped").toEqual(swapped);
    const ca = await decide("oplim", rev.entry.approvalRequestId!, "APPROVE");
    expectStatus(ca, 200, "4. the CA approves the reversal");
    expect((await journal(stored.id)).entry.status, "the original").toBe("REVERSED");
    expect((await journal(reversal!.id)).entry.status, "the reversal").toBe("POSTED");

    const tbAfter = await trialBalance();
    const tb0 = unstash<Record<string, number>>(`${KEY}:tb0`);
    for (const code of ["1010", "4990"]) {
      const delta = (tbAfter.get(code)?.balancePaise ?? 0) - (tbBefore.get(code)?.balancePaise ?? 0);
      const line = original.lines.find((l) => l.accountCode === code)!;
      expect(delta, `${code}: the reversal takes back ${rupees(line.debitPaise - line.creditPaise)}`).toBe(-(line.debitPaise - line.creditPaise));
      if (tb0) expect(tbAfter.get(code)?.balancePaise ?? 0, `${code} back to its balance before the entry was posted`).toBe(tb0[code]);
    }
    const tbPage = await pageAs(browser, "ops");
    try {
      await tbPage.page.goto("/staff/accounting?tab=tb");
      const total = tbPage.page.getByRole("row").filter({ hasText: /^Total/ });
      const cells = await total.getByRole("cell").allInnerTexts();
      expect(cells[1], "trial balance total debits = credits").toBe(cells[2]);
    } finally {
      await tbPage.context.close();
    }
    stash(`${KEY}:entry`, { ...stored, reversed: true });
    return `“abc” refused (422); ${reversal!.entryNumber} “${reversalNarration}” DRAFT with lines swapped; Reverse again → “A reversal of this entry is already being prepared.”; submitted, CA approved → ${stored.entryNumber} REVERSED; 1010 / 4990 net to zero in the trial balance`;
  } finally {
    await restoreRoles();
  }
}, { tier: "signed", partial: "step 1 (UPDATE / DELETE of a posted entry refused by the database trigger) needs database access" });

qa("TC-STAFF-037", "entries of ₹50,000 or more need the CA and then an admin; ₹49,999.99 is posted by the CA alone", async ({ browser }) => {
  const rule = await call(await as("admin"), "GET", "/api/admin/settings");
  expectStatus(rule, 200, "rules");
  const threshold = (rule.body.rules as { key: string; value: { highValueJournalPaise: number } }[]).find((r) => r.key === "rbacV2")?.value.highValueJournalPaise;
  if (threshold !== 5_000_000) blocked(`rule rbacV2.highValueJournalPaise is ${threshold}, not the default 5,000,000 paise`);
  const posted: { id: string; entryNumber: string }[] = [];
  const restored: string[] = [];
  const accounts: [string, string, string, string] = ["1011", "QA bank high value", "4991", "QA income high value"];
  try {
    await actAs("ops", "ACCOUNTANT");
    await actAs("oplim", "CA");
    const below = await submitJournal((await draftJournal(`${TAG} below threshold`, 4_999_999, accounts)).id);
    posted.push(below);
    const at = await submitJournal((await draftJournal(`${TAG} at threshold`, 5_000_000, accounts)).id);
    posted.push(at);
    expect((await approval(below.approvalRequestId!)).request.checker).toBe("CA");
    expect((await approval(at.approvalRequestId!)).request.checker).toBe("CA_THEN_ADMIN");

    const ca = await pageAs(browser, "oplim");
    try {
      await ca.page.goto("/staff/accounting?tab=approvals");
      const belowTitle = `${below.entryNumber}: ${below.narration} (₹49999.99)`;
      const atTitle = `${at.entryNumber}: ${at.narration} (₹50000.00)`;
      const r1 = await clickDecision(ca.page, approvalCard(ca.page, belowTitle).getByRole("button", { name: "Approve", exact: true }), below.approvalRequestId!, "Approved and applied.");
      expect(r1.status, "3. CA approves ₹49,999.99").toBe(200);
      expect(r1.body?.applied).toBe(true);
      await expect(approvalCard(ca.page, belowTitle)).toHaveCount(0);
      const r2 = await clickDecision(ca.page, approvalCard(ca.page, atTitle).getByRole("button", { name: "Approve", exact: true }), at.approvalRequestId!, "Approved and applied.");
      expect(r2.status, "3. CA approves ₹50,000.00").toBe(200);
      expect(r2.body?.applied, "nothing applied at stage 1").toBe(false);
      expect(r2.seen, "the CA's card nevertheless reads “Approved and applied.” (code_check)").toBe(true);
      await expect(approvalCard(ca.page, atTitle), "it leaves the CA's list").toHaveCount(0);
    } finally {
      await ca.context.close();
    }
    expect((await journal(below.id)).entry.status, "₹49,999.99 after the CA").toBe("POSTED");
    expect((await journal(at.id)).entry.status, "₹50,000.00 after the CA").toBe("SUBMITTED");
    expect((await approval(at.approvalRequestId!)).request.stage, "stage 2").toBe(2);

    const admin = await pageAs(browser, "admin");
    try {
      await admin.page.goto("/admin/approvals");
      const card = approvalCard(admin.page, `${at.entryNumber}: ${at.narration} (₹50000.00)`);
      await expect(card, "4. on Admin → Approvals").toHaveCount(1);
      const r3 = await clickDecision(admin.page, card.getByRole("button", { name: "Approve", exact: true }), at.approvalRequestId!, "Approved and applied.");
      expect(r3.status, "5. admin approves").toBe(200);
      expect(r3.body?.applied).toBe(true);
      expect(r3.seen).toBe(true);
    } finally {
      await admin.context.close();
    }
    expect((await journal(at.id)).entry.status, "₹50,000.00 after the admin").toBe("POSTED");
    return `${below.entryNumber} ₹49,999.99 POSTED by the CA alone; ${at.entryNumber} ₹50,000.00 stayed SUBMITTED after the CA (card still said “Approved and applied.”), left the CA's list, on Admin → Approvals, POSTED by the admin`;
  } finally {
    for (const e of posted) restored.push(await reverseFully(e.id, `${TAG}: test entry reversed`));
    console.log(`[TC-STAFF-037] restored: ${restored.join("; ")}`);
    await restoreRoles();
  }
}, { tier: "signed", partial: "step 6 (one user holding CA and Admin approves twice → 403 “The CA who approved this cannot also activate it.”) is blocked: no staging account holds both roles; both test entries were reversed afterwards" });

qa("TC-STAFF-042", "commission change: the Accountant proposes, the CA approves, it waits for an admin and the live commission is untouched", async ({ browser }) => {
  const liveRate = async () => {
    const res = await call(await as("admin"), "GET", "/api/finance/commission-rates");
    expectStatus(res, 200, "commission rates");
    return (res.body as { scope: string; isActive: boolean; rateBp: number }[]).find((r) => r.scope === "DEFAULT" && r.isActive)?.rateBp ?? null;
  };
  const before = await liveRate();
  const reason = `${TAG} rate test`;
  let proposal: { id: string; status: string; approvalRequestId: string } | undefined;
  let cancelled = "";
  const findProposal = async () => {
    const res = await call(await as("admin"), "GET", "/api/staff/accounting/rates");
    expectStatus(res, 200, "rate proposals");
    return (res.body as { id: string; status: string; reason: string; approvalRequestId: string }[]).find((p) => p.reason === reason);
  };
  try {
    await actAs("ops", "ACCOUNTANT");
    await actAs("oplim", "CA");
    const effective = istNow().toISOString().slice(0, 16);
    const { context, page } = await pageAs(browser, "ops");
    try {
      await page.goto("/staff/accounting?tab=rates");
      await expect(page.getByText("Propose a rate change")).toBeVisible();
      await page.getByLabel("Rate", { exact: true }).selectOption({ label: "Default commission (%)" });
      await page.getByLabel("New value", { exact: true }).fill("4.5");
      await page.getByLabel("Effective from (IST)", { exact: true }).fill(effective);
      await page.getByLabel("Reason", { exact: true }).fill(reason);
      const sent = await clickWrite(page, page.getByRole("button", { name: "Send to CA" }), "/api/staff/accounting/rates", "POST");
      expect(sent.status(), "1. send to CA").toBe(201);
      await expect(page.getByText("Proposed. The CA approves it, then an admin activates it.")).toBeVisible();
      proposal = await findProposal();
      expect(proposal?.status).toBe("PENDING_CA");
      await expect(page.getByText("Commission DEFAULT → 4.50%", { exact: true }).first()).toBeVisible();
    } finally {
      await context.close();
    }
    expect(await liveRate(), "2. the live default commission").toBe(before);

    const title = `Commission DEFAULT → 4.50% from ${istDate()}`;
    const ca = await pageAs(browser, "oplim");
    try {
      await ca.page.goto("/staff/accounting?tab=approvals");
      const card = approvalCard(ca.page, title).filter({ hasText: reason });
      await expect(card).toHaveCount(1);
      const res = await clickDecision(ca.page, card.getByRole("button", { name: "Approve", exact: true }), proposal!.approvalRequestId, "Approved and applied.");
      expect(res.status, "3. the CA approves").toBe(200);
      expect(res.body?.applied, "nothing applied at the CA's stage").toBe(false);
    } finally {
      await ca.context.close();
    }
    expect((await findProposal())?.status).toBe("PENDING_ADMIN");
    expect(await liveRate(), "still the live default commission").toBe(before);
    const admin = await pageAs(browser, "admin");
    try {
      await admin.page.goto("/admin/approvals");
      await expect(approvalCard(admin.page, title).filter({ hasText: reason }), "Admin → Approvals shows it").toHaveCount(1);
    } finally {
      await admin.context.close();
    }
  } finally {
    // Never activated: the proposer withdraws it before any admin decides.
    const p = proposal ?? (await findProposal().catch(() => undefined));
    if (p) {
      await actAs("ops", "ACCOUNTANT").catch(() => {});
      const c = await call(await as("ops"), "POST", `/api/staff/accounting/rates/${p.id}/cancel`);
      cancelled = c.status === 200 ? `proposal ${p.id} CANCELLED` : `NOT cancelled (${why(c)}): proposal ${p.id} still waits`;
      console.log(`[TC-STAFF-042] ${cancelled}`);
    }
    await restoreRoles();
  }
  expect(cancelled, "the proposal is withdrawn").toMatch(/CANCELLED/);
  expect((await findProposal())?.status).toBe("CANCELLED");
  expect(await liveRate(), "live default commission after the test").toBe(before);
  return `“Proposed. The CA approves it, then an admin activates it.”; PENDING_CA → (CA) PENDING_ADMIN, shown on Admin → Approvals as “Commission DEFAULT → 4.50% from ${istDate()}”; live default ${before} bp unchanged throughout; ${cancelled}`;
}, { tier: "signed", partial: "activation by an admin (ACTIVATED, 450 bp via the existing setter, audit rate_proposal.activated) is not run: it would change the live commission on staging; the proposal is cancelled instead" });

qa("TC-STAFF-047", "a bank statement import matches by UTR and amount and suggests the rest", async () => {
  try {
    await actAs("oplim", "CA");
    const list = await call(await as("oplim"), "GET", "/api/staff/accounting/bank-statements");
    expectStatus(list, 200, "bank statements");
    const any = (list.body as { id: string }[])[0];
    if (!any) blocked("no bank statement on the site to search the books from");
    const view = await call(await as("oplim"), "GET", `/api/staff/accounting/bank-statements/${any.id}`);
    const debitLine = (view.body.lines as { id: string; debitPaise: number }[]).find((l) => l.debitPaise > 0);
    if (!debitLine) blocked("no debit line to search the books from");
    const found: Record<string, { reference: string | null; amountPaise: number; date: string | null }[]> = {};
    for (const q of ["payout", "Settlement", "transfer", "Refund"]) {
      const res = await call(await as("oplim"), "GET", `/api/staff/accounting/bank-lines/${debitLine.id}?q=${q}`);
      expectStatus(res, 200, `search ${q}`);
      for (const r of res.body as { kind: string; reference: string | null; amountPaise: number; date: string | null }[]) (found[r.kind] ??= []).push(r);
    }
    const shopWithUtr = [...(found.SHOP_PAYOUT ?? []), ...(found.SHOP_SETTLEMENT ?? [])].filter((r) => r.reference);
    const rider = [...(found.RIDER_PAYOUT ?? []), ...(found.RIDER_TRANSFER ?? [])];
    const payoutsWithUtr = Object.entries(found).filter(([k]) => k !== "BANK_REFUND").flatMap(([, v]) => v).filter((r) => r.reference);
    const seen = Object.entries(found).map(([k, v]) => `${k} ${v.length} (${v.map((r) => `${rupees(r.amountPaise)} ref ${r.reference ?? "none"} ${r.date ?? ""}`).join(", ")})`).join("; ") || "none";
    if (shopWithUtr.length < 1 || rider.length < 1 || payoutsWithUtr.length < 2) {
      blocked(`needs unclaimed PAID payout records on staging — a shop payout with a UTR, a rider payout, and a second payout with a UTR; the books hold: ${seen}. Marking payouts paid is a finance write on live shops, not done by this check`);
    }
    blocked(`PAID payout records exist now (${seen}); the import check for them is still to be written`);
  } finally {
    await restoreRoles();
  }
}, { tier: "signed" });

/* ================================================================= support */

qa("TC-STAFF-059", "a Support User works only the tickets assigned to them", async ({ browser }) => {
  const shop = shopA();
  const shopB = world().shops.B;
  if (!shopB?.id) blocked("needs shop B of the staging world");
  const oplim = await me("oplim");
  const ops = await me("ops");
  let own: Ticket | undefined;
  let other: Ticket | undefined;
  const closed: string[] = [];
  try {
    own = await raiseTicket(shop.id, `${TAG} assigned ticket (shop A)`, oplim.id);
    other = await raiseTicket(shopB.id, `${TAG} someone else's ticket (shop B)`, ops.id);
    await actAs("oplim", "SUPPORT_USER");

    const mine = await call(await as("oplim"), "GET", "/api/staff/support/tickets?view=mine");
    expectStatus(mine, 200, "my tickets");
    const rows = mine.body as { id: string; assigneeId: string | null }[];
    expect(rows.some((r) => r.id === own!.id), "the assigned ticket is listed").toBe(true);
    expect(rows.every((r) => r.assigneeId === oplim.id), "only tickets assigned to this user").toBe(true);

    const { context, page } = await pageAs(browser, "oplim");
    try {
      await page.goto("/staff/support");
      await expect(page.getByRole("link", { name: "My tickets" })).toBeVisible();
      await expect(page.getByRole("link", { name: own.ticketNumber, exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: other.ticketNumber, exact: true })).toHaveCount(0);
      await page.getByRole("link", { name: own.ticketNumber, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/admin/support/${own.id}$`));
      await expect(page.getByRole("heading", { name: `${TAG} assigned ticket (shop A)` })).toBeVisible();
      // Soft: a picker shown here is recorded as a failure, and the rest of the case is still checked.
      await expect.soft(page.getByText("Assigned to", { exact: true }), "no assignee picker on the Support User's ticket").toHaveCount(0, { timeout: 5_000 });
      await expect.soft(page.getByRole("button", { name: "Save assignment" }), "no “Save assignment” for the Support User").toHaveCount(0, { timeout: 5_000 });

      await page.goto("/staff/support?tab=mine");
      const card = page.getByRole("link", { name: own.ticketNumber, exact: true }).locator("xpath=../..");
      await card.getByRole("link", { name: "Open shop workbench →" }).click();
      await expect(page).toHaveURL(new RegExp(`/staff/support/shop/${shop.id}\\?ticket=${own.id}$`));
      await expect(page.getByRole("heading", { name: shop.name })).toBeVisible();
      await expect(page.getByText("Shop details", { exact: true })).toBeVisible();
      await expect(page.getByText(/^Products \(selling price ≤ MRP/)).toBeVisible();
      await expect(page.getByLabel(`${PRODUCT.name} online price`, { exact: true })).toBeVisible();
      const text = await page.locator("body").innerText();
      expect(text, "no bank details on the workbench").not.toMatch(/IFSC|account number|bank account/i);

      for (const path of [`/admin/support/${other.id}`, `/staff/support/shop/${shopB.id}?ticket=${own.id}`, `/staff/support/shop/${shop.id}`]) {
        const res = await page.goto(path);
        expect(res?.status(), `${path} → not found`).toBe(404);
        await expect(page.getByTestId("not-found-state")).toBeVisible();
      }
    } finally {
      await context.close();
    }
    const body = { reason: `${TAG}: not mine`, items: [{ target: "SHOP", field: "description", value: "QA" }] };
    expectRefused(await call(await as("oplim"), "POST", `/api/staff/shops/${shopB.id}/changes`, { ...body, ticketId: other.id }), "This ticket is not assigned to you.", "5. propose with someone else's ticket");
    expectRefused(await call(await as("oplim"), "POST", `/api/staff/shops/${shopB.id}/changes`, body), "Open the shop from a ticket assigned to you.", "5. propose with no ticket");
    return `My tickets lists only gk-oplim's tickets (${own.ticketNumber} shown, ${other.ticketNumber} not); ticket page without assignee picker; workbench shows shop details and products, no bank details; the other ticket and both workbench URLs → 404 not-found page; proposals → 403 “This ticket is not assigned to you.” / “Open the shop from a ticket assigned to you.”`;
  } finally {
    closed.push(await closeTicket(own?.id), await closeTicket(other?.id));
    console.log(`[TC-STAFF-059] test tickets: ${closed.join(", ")}`);
    await restoreRoles();
  }
}, { tier: "signed", partial: "“someone else” is gk-ops (Support Manager), as no second Support User exists on staging" });

qa("TC-STAFF-061", "Support proposes a shop and a price change; nothing applies until the owner decides; an unchanged proposal is refused", async ({ browser }) => {
  const shop = shopA();
  const oplim = await me("oplim");
  stash(projectKey("061"), null);
  const before = await liveProduct(shop.id);
  const descBefore = await shopDescription(shop.id);
  const newPrice = before.onlinePricePaise - 400; // ₹4 lower: below the MRP
  const reason = `${TAG} ${test.info().project.name}: description and price for the owner`;
  try {
    const ticket = await raiseTicket(shop.id, `${TAG} shop A details (${test.info().project.name})`, oplim.id);
    stash(projectKey("061"), { ticket, reason, priceBefore: before.onlinePricePaise, descBefore, newPrice });
    await actAs("oplim", "SUPPORT_USER");
    const { context, page } = await pageAs(browser, "oplim");
    try {
      await page.goto("/staff/support?tab=mine");
      const card = page.getByRole("link", { name: ticket.ticketNumber, exact: true }).locator("xpath=../..");
      await card.getByRole("link", { name: "Open shop workbench →" }).click();
      await expect(page.getByText(/^Nothing you change here is applied until the shop owner approves it\./)).toBeVisible();
      await page.getByLabel("Description", { exact: true }).fill(`${TAG} proposed description (to be rejected)`);
      await page.getByLabel(`${PRODUCT.name} online price`, { exact: true }).fill((newPrice / 100).toFixed(2));
      await page.getByLabel("Reason", { exact: true }).fill(reason);
      const sent = await clickWrite(page, page.getByRole("button", { name: "Send to the shop owner" }), `/api/staff/shops/${shop.id}/changes`, "POST");
      expect(sent.status(), "3. send to the owner").toBe(201);
      const request = (await sent.json()) as ApprovalRequest;
      stash(projectKey("061"), { ticket, reason, priceBefore: before.onlinePricePaise, descBefore, newPrice, requestId: request.id });
      await expect(page.getByText(`2 changes to ${shop.name} sent to the shop owner. Nothing changes until they approve.`)).toBeVisible();
      const pending = (await pendingApprovals()).filter((r) => r.type === "SHOP_CHANGE" && r.shopId === shop.id);
      await expect(page.getByRole("heading", { name: `Waiting for the owner (${pending.length})` })).toBeVisible();
      const mineCard = page.getByTestId("pending-shop-changes").locator(":scope > *").filter({ hasText: reason });
      await expect(mineCard.getByText("Waiting for the owner", { exact: true })).toHaveCount(2);

      // 5. Every value equal to today's.
      await page.reload();
      await page.getByLabel("Reason", { exact: true }).fill(`${TAG}: nothing new`);
      await page.getByRole("button", { name: "Send to the shop owner" }).click();
      await expect(page.getByText("Nothing changed.", { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
    const same = await propose(shop.id, ticket.id, `${TAG}: nothing new`, [
      { target: "SHOP", field: "description", value: descBefore },
      { target: "SHOP_PRODUCT", shopProductId: PRODUCT.shopProductId, field: "onlinePricePaise", value: before.onlinePricePaise },
    ]);
    expectStatus(same, 422, "5. API with every value unchanged");
    expect(same.body.error.message).toBe("Every proposed value is the same as the shop's current one.");

    const { requestId } = unstash<{ requestId: string }>(projectKey("061"))!;
    const tickets = await call(await as("oplim"), "GET", "/api/staff/support/tickets?view=mine");
    expect((tickets.body as { id: string; briefStatus: string }[]).find((t) => t.id === ticket.id)?.briefStatus, "the ticket").toBe("Awaiting Shop Owner");
    const told = (await notificationsOf("shop")).find((n) => n.dedupeKey === `shop-change:${requestId}:requested`);
    expect(told?.title, "the owner is told").toBe("Changes to your shop need your approval");
    expect(told?.actionUrl).toBe("/shop/changes");
    expect((await liveProduct(shop.id)).onlinePricePaise, "4. live price unchanged").toBe(before.onlinePricePaise);
    expect(await shopDescription(shop.id), "4. live description unchanged").toBe(descBefore);
    return `“2 changes to ${shop.name} sent to the shop owner…” (request ${requestId}); ticket ${ticket.ticketNumber} Awaiting Shop Owner; owner told “Changes to your shop need your approval” → /shop/changes; both items “Waiting for the owner”; live price ${rupees(before.onlinePricePaise)} and description unchanged; unchanged proposal → “Nothing changed.” / 422 “Every proposed value is the same as the shop's current one.”`;
  } finally {
    await restoreRoles();
  }
}, { tier: "signed", mobile: true });

qa("TC-STAFF-065", "only the shop's owner decides a change request: another shop's owner, the proposer and an admin are refused; customers and guests are sent away", async () => {
  const shop = shopA();
  const oplim = await me("oplim");
  const descBefore = await shopDescription(shop.id);
  let ticket: Ticket | undefined;
  let requestId: string | undefined;
  let cleanup = "";
  try {
    ticket = await raiseTicket(shop.id, `${TAG} decide refusals`, oplim.id);
    await actAs("oplim", "SUPPORT_USER");
    const made = await propose(shop.id, ticket.id, `${TAG}: only the owner decides`, [{ target: "SHOP", field: "description", value: `${TAG} not to be applied` }]);
    expectStatus(made, 201, "a pending change request for shop A");
    requestId = made.body.id as string;

    // 1. The owner of another shop: gk-ops acting as shop owner (it owns a shop of its own, not shop A).
    await actAs("ops", "SHOP_OWNER");
    const ONLY_OWNER = "Only the shop owner can decide this request.";
    expectRefused(await decide("ops", requestId, "APPROVE"), ONLY_OWNER, "1. another shop's owner");
    expectRefused(await decide("oplim", requestId, "APPROVE"), ONLY_OWNER, "2. the Support User who proposed it");
    expectRefused(await decide("admin", requestId, "APPROVE"), ONLY_OWNER, "3. an admin");
    const detail = await approval(requestId);
    expect(detail.request.status).toBe("PENDING");
    expect(detail.items.every((i) => i.status === "PENDING"), "no item decided").toBe(true);
    expect(await shopDescription(shop.id), "nothing applied").toBe(descBefore);

    let customerNote = "";
    const customer = await shopFreeCustomer().catch((error: unknown) => {
      customerNote = `customer step not run (${error instanceof Error ? error.message : String(error)})`;
      return null;
    });
    if (customer) expect(await redirectOf(await as(customer), "/shop/changes"), "4. a customer with no shop").toBe("/shop");
    const guest = await anonymous();
    try {
      expect(await redirectOf(guest, "/shop/changes"), "4. a guest").toBe("/signin");
    } finally {
      await guest.dispose();
    }
    return `request ${requestId}: another shop's owner, the proposing Support User and the admin → 403 “${ONLY_OWNER}”; nothing applied; ${customer ? "customer → /shop" : customerNote}, guest → /signin`;
  } finally {
    if (requestId && (await approval(requestId).catch(() => null))?.request.status === "PENDING") {
      const r = await decide("shop", requestId, "REJECT", `${TAG}: test request, rejected by the owner`);
      cleanup = `owner rejected the test request (${r.status})`;
    }
    cleanup += `; ticket ${await closeTicket(ticket?.id)}`;
    console.log(`[TC-STAFF-065] ${cleanup}`);
    await restoreRoles();
  }
}, { tier: "signed", partial: "step 1 uses gk-ops as the owner of another shop (its own shop; there is no session for shop B's owner); step 4's customer part needs a customer account without a shop (both staging customers own one, so it runs only when one exists); step 5 (flag rbac_v2_shop_change_requests OFF) is blocked: switching a flag needs a second admin under four-eye and is not allowed in this run" });

qa("TC-STAFF-062", "the shop owner decides item by item: a rejection needs a comment, the approved price goes live, the ticket moves on", async ({ browser }) => {
  const shop = shopA();
  const stored = unstash<{ ticket: Ticket; reason: string; priceBefore: number; descBefore: string | null; newPrice: number; requestId?: string }>(projectKey("061"));
  if (!stored?.requestId) blocked("needs the pending change request of TC-STAFF-061");
  const restore: string[] = [];
  try {
    const pending = await approval(stored.requestId);
    if (pending.request.status !== "PENDING") blocked(`the request of TC-STAFF-061 is ${pending.request.status}`);
    const { context, page } = await pageAs(browser, "shop");
    try {
      await page.goto("/shop/changes");
      await expect(page.getByRole("heading", { name: "Pending changes for approval" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Waiting for me" })).toBeVisible();
      await expect(page.getByRole("link", { name: "History" })).toBeVisible();
      const card = page.getByTestId("pending-shop-changes").locator(":scope > *").filter({ hasText: stored.reason });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText(/Proposed by .+ · .+ IST · decide by .+ IST/);
      await expect(card).toContainText(`Reason: ${stored.reason}`);
      for (const head of ["What", "Now", "Proposed", "Your decision"]) await expect(card.getByRole("columnheader", { name: head, exact: true })).toBeVisible();
      if (test.info().project.name === "mobile") {
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(sideways, "no sideways scroll on a phone").toBeLessThanOrEqual(1);
      }
      await card.getByLabel("Decision for Description").selectOption("REJECT");
      await card.getByRole("button", { name: "Save my decisions" }).click();
      await expect(card.getByText("Write why you reject (a comment is required for every rejected item).")).toBeVisible();
      await card.getByLabel("Rejection comment for Description").fill("Keep the old text");
      const res = await clickDecision(page, card.getByRole("button", { name: "Save my decisions" }), stored.requestId, "Saved. Approved items are live now.");
      expect(res.status, "3. save").toBe(200);
      expect(res.body?.applyError ?? null).toBeNull();
      expect(res.seen, "“Saved. Approved items are live now.”").toBe(true);

      await page.goto("/shop/changes?tab=history");
      const past = page.getByTestId("pending-shop-changes").locator(":scope > *").filter({ hasText: stored.reason });
      await expect(past.getByText("PARTIALLY APPROVED", { exact: true })).toBeVisible();
      await expect(past.getByText("Keep the old text")).toBeVisible();
    } finally {
      await context.close();
    }
    expect((await liveProduct(shop.id)).onlinePricePaise, "the approved price is live").toBe(stored.newPrice);
    expect(await shopDescription(shop.id), "the rejected description is unchanged").toBe(stored.descBefore);
    const tickets = await call(await as("oplim"), "GET", "/api/staff/support/tickets?view=mine");
    expect((tickets.body as { id: string; briefStatus: string }[]).find((t) => t.id === stored.ticket.id)?.briefStatus, "the ticket").toBe("In Progress");
    const told = (await notificationsOf("oplim")).find((n) => n.dedupeKey === `shop-change:${stored.requestId}:decided`);
    expect(told?.title, "the Support User is told").toBe("Shop owner decided on your changes");
    expect(told?.body).toMatch(/: 1 applied, 1 rejected\.$/);
    return `owner: no-comment rejection stopped (“Write why you reject…”); with “Keep the old text” → “Saved. Approved items are live now.”; price ${rupees(stored.newPrice)} live, description unchanged; History PARTIALLY APPROVED with the comment; ticket In Progress; Support User told “Shop owner decided on your changes” (1 applied, 1 rejected)`;
  } finally {
    const live = await liveProduct(shop.id).catch(() => null);
    if (live && live.onlinePricePaise !== stored.priceBefore) {
      const r = await call(await as("shop"), "PATCH", `/api/shop-products/${PRODUCT.shopProductId}`, { onlinePricePaise: stored.priceBefore });
      restore.push(`price back to ${rupees(stored.priceBefore)} by the owner (${r.status})`);
    }
    if ((await approval(stored.requestId).catch(() => null))?.request.status === "PENDING") {
      const r = await decide("shop", stored.requestId, "REJECT", `${TAG}: test request, rejected by the owner`);
      restore.push(`request rejected (${r.status})`);
    }
    if ((await shopDescription(shop.id).catch(() => stored.descBefore)) !== stored.descBefore) {
      const r = await call(await as("shop"), "PATCH", `/api/shops/${shop.id}`, { description: stored.descBefore });
      restore.push(`description restored (${r.status})`);
    }
    restore.push(`ticket ${await closeTicket(stored.ticket.id)}`);
    console.log(`[TC-STAFF-062] ${restore.join("; ")}`);
    await restoreRoles();
  }
}, { tier: "signed", mobile: true });

qa("TC-STAFF-063", "Approve all applies a shop-only MRP and a price through the owner's own rules and resolves the ticket; the master MRP is untouched", async ({ browser }) => {
  const shop = shopA();
  const oplim = await me("oplim");
  const before = await liveProduct(shop.id);
  const master = await masterMrp(shop.id);
  if (master == null) blocked(`"${PRODUCT.name}" has no master MRP to compare with`);
  const newMrp = master + 1000; // ₹10 above the master MRP: shop A's own
  const newPrice = master + 600; // below the new MRP, above the master MRP
  const reason = `${TAG}: shop MRP and price for the owner`;
  let ticket: Ticket | undefined;
  let requestId: string | undefined;
  const restore: string[] = [];
  try {
    ticket = await raiseTicket(shop.id, `${TAG} MRP correction`, oplim.id);
    await actAs("oplim", "SUPPORT_USER");
    const above = await propose(shop.id, ticket.id, reason, [{ target: "SHOP_PRODUCT", shopProductId: PRODUCT.shopProductId, field: "onlinePricePaise", value: master + 2000 }]);
    expectStatus(above, 422, "a price above the MRP");
    expect(above.body.error.message).toBe(`${PRODUCT.name}: online selling price ₹${((master + 2000) / 100).toFixed(2)} is above the MRP ₹${(master / 100).toFixed(2)}.`);
    const made = await propose(shop.id, ticket.id, reason, [
      { target: "SHOP_PRODUCT", shopProductId: PRODUCT.shopProductId, field: "shopMrpPaise", value: newMrp },
      { target: "SHOP_PRODUCT", shopProductId: PRODUCT.shopProductId, field: "onlinePricePaise", value: newPrice },
    ]);
    expectStatus(made, 201, "Support proposes MRP (this shop only) and an online price");
    requestId = made.body.id as string;

    const { context, page } = await pageAs(browser, "shop");
    try {
      await page.goto("/shop/changes");
      const card = page.getByTestId("pending-shop-changes").locator(":scope > *").filter({ hasText: reason });
      await expect(card.getByText("MRP (this shop only)")).toBeVisible();
      const res = await clickDecision(page, card.getByRole("button", { name: "Approve all" }), requestId, "Saved. Approved items are live now.");
      expect(res.status, "1. Approve all").toBe(200);
      expect(res.body?.applyError ?? null).toBeNull();
    } finally {
      await context.close();
    }
    const after = await liveProduct(shop.id);
    expect(after.onlinePricePaise, "2. the price applied").toBe(newPrice);
    expect(after.mrpPaise, "2. the shop's own MRP applied").toBe(newMrp);
    expect(await masterMrp(shop.id), "2. the master MRP").toBe(master);
    expect((await approval(requestId)).request.status).toBe("APPROVED");
    expect(await ticketStatus(ticket.id), "the ticket").toBe("RESOLVED");
    return `price ≤ MRP enforced (₹${((master + 2000) / 100).toFixed(2)} refused); Approve all → price ${rupees(newPrice)} and shop MRP ${rupees(newMrp)} live, master MRP ${rupees(master)} unchanged; request APPROVED; ticket ${ticket.ticketNumber} RESOLVED`;
  } finally {
    // Back to the price and MRP it had: a second change request the owner approves (the shop MRP row stays, at the master's value).
    try {
      const live = await liveProduct(shop.id);
      if (ticket && (live.onlinePricePaise !== before.onlinePricePaise || live.mrpPaise !== before.mrpPaise)) {
        await actAs("oplim", "SUPPORT_USER");
        const items = [
          ...(live.mrpPaise !== before.mrpPaise && before.mrpPaise != null ? [{ target: "SHOP_PRODUCT", shopProductId: PRODUCT.shopProductId, field: "shopMrpPaise", value: before.mrpPaise }] : []),
          ...(live.onlinePricePaise !== before.onlinePricePaise ? [{ target: "SHOP_PRODUCT", shopProductId: PRODUCT.shopProductId, field: "onlinePricePaise", value: before.onlinePricePaise }] : []),
        ];
        const back = await propose(shop.id, ticket.id, `${TAG}: restore the price and MRP after the test`, items);
        if (back.status === 201) {
          const ok = await decide("shop", back.body.id, "APPROVE");
          restore.push(`restore request ${back.body.id} approved by the owner (${ok.status})`);
        } else {
          restore.push(`restore request refused (${why(back)})`);
          const r = await call(await as("shop"), "PATCH", `/api/shop-products/${PRODUCT.shopProductId}`, { onlinePricePaise: before.onlinePricePaise });
          restore.push(`price by the owner (${r.status})`);
        }
        const now = await liveProduct(shop.id);
        restore.push(`now price ${rupees(now.onlinePricePaise)}, MRP ${now.mrpPaise == null ? "none" : rupees(now.mrpPaise)}`);
      }
      if (requestId && (await approval(requestId).catch(() => null))?.request.status === "PENDING") {
        const r = await decide("shop", requestId, "REJECT", `${TAG}: test request, rejected by the owner`);
        restore.push(`request rejected (${r.status})`);
      }
    } catch (error) {
      restore.push(`restore failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    restore.push(`ticket ${await closeTicket(ticket?.id)}`);
    console.log(`[TC-STAFF-063] ${restore.join("; ")}`);
    await restoreRoles();
  }
}, { tier: "signed", partial: "shop_mrp_history (row with previous / new MRP, source CHANGE_REQUEST, approval id) and its UPDATE / DELETE refusal need database access; the “… resolved — please confirm” notice to an Operations raiser is not checked (the ticket is raised by the Support Manager)" });
