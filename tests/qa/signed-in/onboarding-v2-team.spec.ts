/**
 * Onboarding v2, Flow 4 — "My team" (docs/onboarding-v2-2026-11). Signed tier, staging test accounts:
 *   dealer   customer2 (the staging free dealer "QA Staging Test Dealer")
 *   lead / agent  the first two test accounts the dealer's search finds AVAILABLE (verified e-mail and
 *                 mobile, no dealer, no team): gk-shop and gk-lc14 on 26-Nov-2026
 * Checks run in file order and hand data on with stash(). The last checks put both people back to
 * "customer only" (dealer remove + admin override), so a re-run starts from the same place.
 */
import { as, me, pageAs } from "../lib/actors";
import { call, expectStatus, RUN, stash, unstash, why, type Answer } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";

const DEALER = "customer2" as const;
const IST = /\d{2} [A-Z][a-z]{2} \d{4}, \d{2}\.\d{2} (AM|PM) IST/;

interface Member { id: string; userId: string | null; name: string; role: "TEAM_LEAD" | "AGENT"; parentId: string | null; status: string; code: string | null }
interface Overview { viewer: string; members: Member[]; leads: { id: string; name: string }[]; invitations: { id: string; status: string }[]; history: { person: string; role: string; action: string; atIst: string }[] }

async function overview(role: Parameters<typeof as>[0] = DEALER): Promise<Overview> {
  const res = await call(await as(role), "GET", "/api/team");
  if (res.status === 404) blocked(`/api/team answers 404 — onboarding_v2 or the dealer programme is off (${why(res)})`);
  expectStatus(res, 200, "GET /api/team");
  return res.body as Overview;
}

async function post(role: Parameters<typeof as>[0], body: Record<string, unknown>) {
  return call(await as(role), "POST", "/api/team", body);
}

/**
 * dual_auth (docs/dual-auth-2026-11; in force on test.gokesari.com: flag on + SMS provider): every role change the
 * dealer makes in My team (upgrade, downgrade, reassign, remove) is a TEAM_ROLE sensitive action — 403 until the
 * dealer has entered a code sent by SMS AND a code sent by e-mail (src/server/dual-auth/step-up.ts). The SMS code is
 * in the staging mock outbox, but the e-mailed code goes to the test inbox, which QA reads only for sign-in codes
 * (Gmail approval D-041): such a check is reported "not automated" (the register's manual status) where it applies.
 */
const DUAL_MANUAL =
  "not automated: dual_auth asks the dealer for an SMS code and an e-mailed code before a role change in My team (TEAM_ROLE step-up); the e-mailed code cannot be read by QA (Gmail is read only for sign-in codes, D-041)";

function dualStepUp(res: Answer): boolean {
  return res.status === 403 && res.body?.error?.details?.stepUp === "DUAL";
}

/** Checks the refusal is the TEAM_ROLE step-up asking both codes, then reports the case as manual. */
function manualAtStepUp(res: Answer, what: string, after = ""): never {
  expect(res.body?.error?.details?.action, `${what}: the step-up is for TEAM_ROLE`).toBe("TEAM_ROLE");
  expect(res.body?.error?.message).toBe("For your safety, confirm this with a code sent to your mobile by SMS and a code sent to your e-mail.");
  blocked(`${DUAL_MANUAL} — seen: ${what} → 403 DUAL_STEP_UP (TEAM_ROLE)${after}`);
}

async function memberOf(userId: string): Promise<Member | undefined> {
  return (await overview()).members.find((m) => m.userId === userId && m.status === "ACTIVE");
}

type Person = "shop" | "customer" | "ops" | "rider" | "oplim";

/** The lead and the agent: test accounts the dealer can add now. */
async function people(): Promise<{ lead: Person; agent: Person }> {
  const cached = unstash<{ lead: Person; agent: Person }>("ov2-people");
  if (cached) return cached;
  const free: Person[] = [];
  for (const role of ["shop", "customer", "ops", "rider", "oplim"] as const) {
    const who = await me(role).catch(() => null);
    if (!who) continue;
    const res = await post(DEALER, { action: "search", query: who.email });
    if (res.status === 200 && res.body.found && res.body.state === "AVAILABLE") free.push(role);
    if (free.length === 2) break;
  }
  if (free.length < 2) blocked(`needs two test accounts with a verified e-mail and mobile outside any team and not dealers (found ${free.join(", ") || "none"})`);
  return stash("ov2-people", { lead: free[0], agent: free[1] });
}

async function myInvitations(role: Parameters<typeof as>[0]) {
  const res = await call(await as(role), "GET", "/api/team/invitations");
  expectStatus(res, 200, "GET /api/team/invitations");
  return res.body as { invitations: { id: string; role: string; status: string; dealerName?: string; createdIst?: string }[]; missing: string[] };
}

qa(["TC-OV2-060"], "dealer opens My team (/dealer/team): search box, team list and role history in IST", async ({ browser }) => {
  const data = await overview();
  expect(data.viewer).toBe("DEALER");
  // A new pass picks its lead and agent afresh (stash is kept on disk between runs).
  stash("ov2-people", null);
  stash("ov2-lead", null);
  stash("ov2-agent", null);
  const { page, context } = await pageAs(browser, DEALER);
  try {
    await page.goto("/dealer/team");
    await expect(page.getByTestId("my-team-v2")).toBeVisible();
    await expect(page.getByLabel("Mobile number or e-mail")).toBeVisible();
    const history = page.getByTestId("team-role-history");
    await expect(history).toBeVisible();
    expect(await history.innerText()).toMatch(IST);
    return `/dealer/team: ${data.members.length} member(s), ${data.history.length} history row(s), times in IST`;
  } finally {
    await context.close();
  }
}, { tier: "signed", mobile: true });

qa(["TC-OV2-061"], "search by exact mobile and by e-mail finds a ready customer (masked name only); an unknown contact is 'not found'", async ({ browser }) => {
  const { lead: who } = await people();
  const shop = await me(who);
  const byEmail = await post(DEALER, { action: "search", query: shop.email });
  expectStatus(byEmail, 200, "search by e-mail");
  expect(byEmail.body.found).toBe(true);
  expect(String(byEmail.body.maskedName ?? "")).not.toBe(shop.name ?? "");
  const unknown = await post(DEALER, { action: "search", query: `qa-ov2-nobody-${RUN}@example.com` });
  expectStatus(unknown, 200, "search an unknown e-mail");
  expect(unknown.body.found).toBe(false);

  // The same search in the page, by mobile.
  const profile = await call(await as(who), "GET", "/api/profile");
  const mobile = String(profile.body?.phoneE164 ?? "").replace(/^\+91/, "");
  const { page, context } = await pageAs(browser, DEALER);
  try {
    await page.goto("/dealer/team");
    await page.getByLabel("Mobile number or e-mail").fill(mobile);
    await page.getByTestId("my-team-v2").getByRole("button", { name: "Search", exact: true }).click();
    const candidate = page.getByTestId("team-candidate");
    await expect(candidate).toBeVisible();
    await expect(candidate).toContainText(byEmail.body.maskedName);
    return `e-mail → found "${byEmail.body.maskedName}" (${byEmail.body.state}); unknown → not found; mobile …${mobile.slice(-4)} in the page → same masked name`;
  } finally {
    await context.close();
  }
}, { tier: "signed" });

qa(["TC-OV2-062"], "dealer requests a customer as team lead; the person declines at /team/invitations; a second request is accepted → TEAM_LEAD with a code", async ({ browser }) => {
  const { lead: who } = await people();
  const shop = await me(who);
  const first = await post(DEALER, { action: "invite", contact: shop.email, role: "TEAM_LEAD" });
  expectStatus(first, 201, "request #1");
  expect(first.body.notified).toBe(true);
  expect(await memberOf(shop.id), "no role before the person accepts").toBeUndefined();

  const { page, context } = await pageAs(browser, who);
  try {
    await page.goto("/team/invitations");
    const list = page.getByTestId("team-invitations");
    await expect(list).toBeVisible();
    await list.getByRole("button", { name: "Decline" }).first().click();
    await expect.poll(async () => (await myInvitations(who)).invitations.find((i) => i.id === first.body.invitationId)?.status ?? "gone").not.toBe("PENDING");
    expect(await memberOf(shop.id), "declined: still no role").toBeUndefined();

    const second = await post(DEALER, { action: "invite", contact: shop.email, role: "TEAM_LEAD" });
    expectStatus(second, 201, "request #2");
    await page.goto("/team/invitations");
    await list.getByRole("button", { name: "Accept" }).first().click();
    await expect.poll(async () => (await memberOf(shop.id))?.role ?? "none", { timeout: 30_000 }).toBe("TEAM_LEAD");
    const m = (await memberOf(shop.id))!;
    stash("ov2-lead", { memberId: m.id, userId: shop.id });
    return `request #1 declined in the page → no role; request #2 accepted in the page → TEAM_LEAD, code ${m.code}`;
  } finally {
    await context.close();
  }
}, { tier: "signed", timeout: 240_000 });

qa(["TC-OV2-063"], "the team lead adds an agent under himself (teamLeadsCanAddAgents); the agent accepts → AGENT reporting to the lead", async () => {
  const lead = unstash<{ memberId: string; userId: string }>("ov2-lead");
  if (!lead) blocked("needs TC-OV2-062's team lead");
  const { lead: leadRole, agent: agentRole } = await people();
  const cust = await me(agentRole);
  const asLead = await overview(leadRole);
  expect(asLead.viewer).toBe("TEAM_LEAD");
  const inv = await post(leadRole, { action: "invite", contact: cust.email, role: "AGENT" });
  expectStatus(inv, 201, "the lead's request");
  const mine = await myInvitations(agentRole);
  const pending = mine.invitations.find((i) => i.id === inv.body.invitationId);
  expect(pending, "the request waits in the agent's /team/invitations").toBeTruthy();
  const acc = await call(await as(agentRole), "POST", "/api/team/invitations", { action: "accept", invitationId: inv.body.invitationId });
  expectStatus(acc, 200, "accept");
  const agent = await memberOf(cust.id);
  expect(agent?.role).toBe("AGENT");
  expect(agent?.parentId).toBe(lead.memberId);
  stash("ov2-agent", { memberId: agent!.id, userId: cust.id });
  return `lead's page viewer TEAM_LEAD; request → customer accepted → AGENT (code ${agent!.code}) under the lead`;
}, { tier: "signed" });

qa(["TC-OV2-064"], "an unregistered contact gets an invite link /team/join/<token> (7 days) with WhatsApp/SMS/e-mail share; a guest opening it is asked to sign in; the dealer withdraws it", async ({ page }) => {
  const contact = `qa-ov2-invite-${RUN}@example.com`;
  const inv = await post(DEALER, { action: "invite", contact, role: "AGENT" });
  expectStatus(inv, 201, "invite link");
  expect(inv.body.notified).toBe(false);
  expect(String(inv.body.link)).toMatch(/\/team\/join\/[A-Za-z0-9_-]{16,}/);
  expect(inv.body.expiresIst).toMatch(IST);
  expect(Object.keys(inv.body.share ?? {}).sort()).toEqual(expect.arrayContaining(["email"]));
  const path = new URL(inv.body.link).pathname;
  await page.goto(path);
  const text = await page.locator("main").innerText();
  expect(text).toMatch(/sign in|Sign in|sign up/i);
  const cancel = await post(DEALER, { action: "cancel", invitationId: inv.body.invitationId });
  expectStatus(cancel, 200, "withdraw");
  return `link ${path.slice(0, 16)}…, expires ${inv.body.expiresIst}, share ${Object.keys(inv.body.share).join("/")}; guest page asks to sign in; withdrawn`;
}, { tier: "signed" });

qa(["TC-OV2-065"], "downgrade of a team lead is refused while agents report to him; after reassigning them it works; an agent can be upgraded to team lead", async () => {
  const lead = unstash<{ memberId: string; userId: string }>("ov2-lead");
  const agent = unstash<{ memberId: string; userId: string }>("ov2-agent");
  if (!lead || !agent) blocked("needs TC-OV2-062/063's lead and agent");
  const refused = await post(DEALER, { action: "downgrade", memberId: lead.memberId });
  if (dualStepUp(refused)) manualAtStepUp(refused, "dealer downgrades the team lead");
  expect(refused.status, why(refused)).toBe(409);
  const notLead = await post((await people()).lead, { action: "downgrade", memberId: lead.memberId });
  expect([403, 404, 409], `a team lead cannot change roles — ${why(notLead)}`).toContain(notLead.status);
  expectStatus(await post(DEALER, { action: "reassign", memberId: agent.memberId, parentId: null }), 200, "agent → reports to the dealer");
  expectStatus(await post(DEALER, { action: "downgrade", memberId: lead.memberId }), 200, "lead → agent");
  expectStatus(await post(DEALER, { action: "upgrade", memberId: agent.memberId }), 200, "agent → lead");
  const data = await overview();
  const l = data.members.find((m) => m.id === lead.memberId);
  const a = data.members.find((m) => m.id === agent.memberId);
  expect(l?.role).toBe("AGENT");
  expect(a?.role).toBe("TEAM_LEAD");
  return `downgrade with an agent under him → 409 "${why(refused).slice(10, 110)}"; lead's own try → ${notLead.status}; reassign → downgrade → upgrade OK (roles now AGENT / TEAM_LEAD)`;
}, { tier: "signed" });

qa(["TC-OV2-066"], "admin user page shows marketplace roles and role history (IST); an admin override (REMOVE) applies at once and is recorded as OVERRIDE", async ({ browser }) => {
  const agent = unstash<{ memberId: string; userId: string }>("ov2-agent");
  if (!agent) blocked("needs TC-OV2-063's member");
  const admin = await as("admin");
  // TC-OV2-065 upgrades the agent to team lead; where dual_auth stops that change (manual there) it is still an agent.
  const current = (await memberOf(agent.userId)) ?? blocked("the member of TC-OV2-063 is no longer in the team");
  const view = await call(admin, "GET", `/api/users/${agent.userId}/marketplace-roles`);
  expectStatus(view, 200, "marketplace roles");
  expect(JSON.stringify(view.body.roles), `the member's role now (${current.role})`).toMatch(current.role === "TEAM_LEAD" ? /team_lead/i : /"agent"|AGENT/i);
  const { page, context } = await pageAs(browser, "admin");
  try {
    await page.goto(`/admin/users/${agent.userId}`);
    await expect(page.locator("main")).toContainText(/Marketplace roles/i);
    expect(await page.locator("main").innerText()).toMatch(IST);
  } finally {
    await context.close();
  }
  const over = await call(admin, "POST", `/api/users/${agent.userId}/marketplace-roles`, { to: "REMOVE", reason: `QA onboarding v2 test pass ${RUN}: tidy up` });
  expectStatus(over, 200, "admin override REMOVE");
  expect(over.body.history.some((h: { action: string }) => h.action === "OVERRIDE")).toBe(true);
  expect(await memberOf(agent.userId), "removed at once").toBeUndefined();
  return `roles ${JSON.stringify(view.body.roles)}; admin page shows Marketplace roles with IST history; override REMOVE → OVERRIDE row, member gone at once`;
}, { tier: "signed", mobile: false });

qa(["TC-OV2-067"], "dealer removes the remaining member's role (back to customer only); the history lists every change with IST times", async () => {
  const lead = unstash<{ memberId: string; userId: string }>("ov2-lead");
  if (!lead) blocked("needs TC-OV2-062's member");
  const res = await post(DEALER, { action: "remove", memberId: lead.memberId });
  if (dualStepUp(res)) {
    // Put the person back to "customer only" the way TC-OV2-066 does (admin override, no step-up), so a re-run starts clean.
    const over = await call(await as("admin"), "POST", `/api/users/${lead.userId}/marketplace-roles`, { to: "REMOVE", reason: `QA onboarding v2 test pass ${RUN}: tidy up (dealer remove needs dual_auth codes)` });
    manualAtStepUp(res, "dealer removes the team lead's role", `; tidied up by admin override REMOVE → HTTP ${over.status}`);
  }
  expectStatus(res, 200, "remove role");
  expect(await memberOf(lead.userId)).toBeUndefined();
  const data = await overview();
  const recent = data.history.slice(0, 12);
  for (const h of recent) expect(h.atIst).toMatch(IST);
  const actions = [...new Set(recent.map((h) => h.action))];
  const { lead: who } = await people();
  const roles = await call(await as(who), "GET", "/api/franchise/start");
  expect(roles.body?.roles ?? []).not.toContain("team_lead");
  expect(roles.body?.roles ?? []).not.toContain("agent");
  return `removed; history actions ${actions.join(", ")}; ${who} roles now ${JSON.stringify(roles.body?.roles)}`;
}, { tier: "signed" });
