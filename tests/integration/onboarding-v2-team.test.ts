/**
 * Onboarding v2, Flow 4 — "My team" (docs/onboarding-v2-2026-11), against real PostgreSQL:
 *   - search by mobile / e-mail (exact, masked name); request → the person accepts (role added only then) or declines
 *   - team lead, agent under the dealer, agent under a lead; a lead adds agents under himself (rule on / off)
 *   - invite link for someone without an account → sign up → claim → accept; expired link
 *   - upgrade, downgrade blocked until the lead's agents are reassigned, reassign, remove (back to customer), rejoin
 *   - role history (IST), mapping history, admin override (OVERRIDE)
 *   - the 20 / 4 / 3 chain for a shop signed by an agent under a lead under the dealer, all made through v2;
 *     after a reassignment new shops follow the new place, earlier commission untouched
 *   - flag off: nothing here is reachable
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { AGENT_AGREEMENT_VERSION } from "@/lib/dealer-tiers";
import { db } from "@/server/db";
import {
  accounts,
  dealerCommissionLedger,
  dealerCommissionMonths,
  dealerSalespeople,
  dealerTeamMappingHistory,
  dealers,
  notifications,
  onboardingRoleHistory,
  sellerVerifications,
  shopAttributions,
  shops,
  teamInvitations,
  users,
} from "@/server/db/schema";
import { resetRateLimits } from "@/server/api/rate-limit";
import { setCommissionSettings } from "@/server/dealers/commission";
import { setDealerCommissionModel } from "@/server/dealers/tiered";
import { listMarketplaceRoles } from "@/server/onboarding-v2/roles";
import {
  adminMarketplaceRoleView,
  adminOverrideTeamRole,
  cancelTeamInvitation,
  claimTeamInvitation,
  downgradeToAgent,
  inviteTeamMember,
  listMyTeamInvitations,
  reassignAgent,
  removeTeamRole,
  respondToTeamInvitation,
  searchTeamCandidate,
  TEAM_INVITES_PER_DEALER_PER_DAY,
  teamOverview,
  upgradeToTeamLead,
} from "@/server/onboarding-v2/team";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { recordPayment } from "@/server/services/shop-payments";
import { approveShop } from "@/server/services/shops";
import { RULES } from "@/server/config/rules";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: "ADMIN" };
const ORIGIN = "https://test.gokesari.com";

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionMonths);
  await db.delete(teamInvitations);
  await db.delete(onboardingRoleHistory);
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setCommissionSettings(
    { catalogueMinProducts: 1, branchEligible: false, commissionModel: "BASE_PERCENT", basePercentBp: 4000, ratingStepBp: 100, autoApproveAtMonthEnd: true, payoutDayOfMonth: 5 },
    "test defaults",
    admin,
  );
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
  await setFeatureFlag("dealer_rating_bonus_enabled", { enabled: false, districtCodes: null }, "off (test)", admin);
  await setFeatureFlag("onboarding_v2", { enabled: true, districtCodes: null }, "v2 team (test)", admin);
  for (const key of ["dealerTieredCommission", "dealerPayoutTds", "dealerPayouts", "dealerAutoPayout", "onboardingV2"]) await db.execute(sql`delete from platform_settings where key = ${key}`);
  const { FRANCHISE_DEFAULTS } = await import("@/server/franchise/config");
  const { franchiseConfigVersions } = await import("@/server/db/schema");
  await db.delete(franchiseConfigVersions);
  await db.insert(franchiseConfigVersions).values({ version: 1, effectiveFrom: new Date("2026-01-01T00:00:00Z"), config: FRANCHISE_DEFAULTS, reason: "v2 team tests" });
  // The owner's structure (rule defaults): 20% direct, 4% one level up, 3% two levels up, all at registration.
  await setRule("dealerTieredCommission", { ...RULES.dealerTieredCommission.defaults, enabled: true }, admin);
  clearRuleCache();
});

/** A registered customer: SMS-verified mobile, and (ready) a verified e-mail. */
async function customer(name: string, ready = true) {
  const u = await createUser({ name });
  await db.update(users).set({ phoneVerifiedAt: new Date(), ...(ready ? { emailVerified: new Date() } : {}) }).where(eq(users.id, u.id));
  const [row] = await db.select().from(users).where(eq(users.id, u.id));
  return { ...row, actor: { id: row.id, role: row.role } };
}

/** An approved TIERED dealer (PAN, verified bank, agreement). */
async function newDealer(name = "Shree Sai Network") {
  const user = await createUser({ role: "DEALER", name: "Sai" });
  const [dealer] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: name, contactName: "Sai", dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${user.id}`, bankStatus: "VERIFIED", tierAgreementVersion: AGENT_AGREEMENT_VERSION, tierAgreementAcceptedAt: new Date() })
    .returning();
  await setDealerCommissionModel(dealer.id, "TIERED", "v2 team (test)", admin);
  return { dealer, actor: { id: user.id, role: "DEALER" as const } };
}

const mobileOf = (u: { phoneE164: string | null }) => u.phoneE164!.slice(3);

/** Request + accept: the person's member row. */
async function join(dealerActor: { id: string; role: "DEALER" | "CUSTOMER" }, person: Awaited<ReturnType<typeof customer>>, role: "TEAM_LEAD" | "AGENT", parentId: string | null = null) {
  const inv = await inviteTeamMember(dealerActor as never, { contact: mobileOf(person), role, parentId, origin: ORIGIN });
  const res = await respondToTeamInvitation(person.actor as never, inv.invitationId, true);
  const [m] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, res.salespersonId!));
  return m;
}

const history = (userId: string) => db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.userId, userId)).orderBy(onboardingRoleHistory.createdAt);

describe("flag off: exactly today", () => {
  it("every v2 team entry point is not available", async () => {
    const { actor } = await newDealer();
    const p = await customer("Ramesh Kumar");
    await setFeatureFlag("onboarding_v2", { enabled: false, districtCodes: null }, "off (test)", admin);
    await expect(searchTeamCandidate(actor, mobileOf(p))).rejects.toThrow(/not available/);
    await expect(inviteTeamMember(actor, { contact: mobileOf(p), role: "AGENT", origin: ORIGIN })).rejects.toThrow(/not available/);
    await expect(teamOverview(actor)).rejects.toThrow(/not available/);
    await expect(listMyTeamInvitations(p.actor)).rejects.toThrow(/not available/);
    expect(await db.select().from(teamInvitations)).toHaveLength(0);
  });
});

describe("search and request", () => {
  it("finds a registered customer by exact mobile or e-mail and shows only a masked name", async () => {
    const { actor } = await newDealer();
    const p = await customer("Ramesh Kumar");
    expect(await searchTeamCandidate(actor, `+91 ${mobileOf(p)}`)).toMatchObject({ found: true, maskedName: "Ra**** Ku***", state: "AVAILABLE" });
    expect(await searchTeamCandidate(actor, p.email.toUpperCase())).toMatchObject({ found: true, state: "AVAILABLE" });
    expect(await searchTeamCandidate(actor, "9000000001")).toMatchObject({ found: false });
    await expect(searchTeamCandidate(actor, "Ramesh")).rejects.toThrow(/mobile number or e-mail/);
    // One answer for "no account", "not complete", "a dealer", "in another team" (no enumeration).
    const notReady = await customer("Suresh", false);
    expect(await searchTeamCandidate(actor, mobileOf(notReady))).toEqual({ found: false, contact: expect.any(String) });
    const { actor: other } = await newDealer("Other Network");
    const elsewhere = await customer("Elsewhere");
    await join(other, elsewhere, "AGENT");
    expect(await searchTeamCandidate(actor, mobileOf(elsewhere))).toEqual({ found: false, contact: expect.any(String) });
    const [otherDealerUser] = await db.select().from(users).where(eq(users.id, other.id));
    await db.update(users).set({ emailVerified: new Date(), phoneVerifiedAt: new Date() }).where(eq(users.id, other.id));
    expect(await searchTeamCandidate(actor, otherDealerUser.email)).toEqual({ found: false, contact: expect.any(String) });
    await expect(inviteTeamMember(actor, { contact: mobileOf(elsewhere), role: "AGENT", origin: ORIGIN })).rejects.toThrow("This person cannot be added to your team.");
    await expect(inviteTeamMember(actor, { contact: otherDealerUser.email, role: "AGENT", origin: ORIGIN })).rejects.toThrow("This person cannot be added to your team.");
    // A request to a not-complete account reaches them, but the dealer is not told the account exists.
    const inv = await inviteTeamMember(actor, { contact: mobileOf(notReady), role: "AGENT", origin: ORIGIN });
    expect(inv).toMatchObject({ notified: false, maskedName: null });
    expect((await listMyTeamInvitations(notReady.actor)).invitations).toHaveLength(1);
  });

  it("a linked Google account counts as a verified e-mail, as at checkout", async () => {
    const { actor } = await newDealer();
    const p = await customer("Google User", false);
    expect((await searchTeamCandidate(actor, mobileOf(p))).found).toBe(false);
    await db.insert(accounts).values({ userId: p.id, type: "oidc", provider: "google", providerAccountId: `g-${p.id}` });
    expect(await searchTeamCandidate(actor, mobileOf(p))).toMatchObject({ found: true, state: "AVAILABLE" });
  });

  it("rate limits: 30 searches an hour per dealer, 20 requests a day per dealer", async () => {
    const { dealer, actor } = await newDealer();
    for (let i = 0; i < 30; i++) await searchTeamCandidate(actor, `90000000${String(i).padStart(2, "0")}`);
    await expect(searchTeamCandidate(actor, "9000000099")).rejects.toThrow(/Too many requests/);
    await db.insert(teamInvitations).values(
      Array.from({ length: TEAM_INVITES_PER_DEALER_PER_DAY }, (_, i) => ({ dealerId: dealer.id, invitedByUserId: actor.id, inviteeEmail: `p${i}@example.com`, role: "AGENT" as const, tokenHash: `h${i}-${dealer.id}`, status: "CANCELLED" as const, expiresAt: new Date(Date.now() + 86_400_000) })),
    );
    await expect(inviteTeamMember(actor, { contact: "late@example.com", role: "AGENT", origin: ORIGIN })).rejects.toThrow(/20 requests a day/);
  });

  it("adds a team lead only when he accepts: notified in the app, then customer + team lead with a GKT code", async () => {
    const { dealer, actor } = await newDealer();
    const p = await customer("Ramesh Kumar");
    const inv = await inviteTeamMember(actor, { contact: mobileOf(p), role: "TEAM_LEAD", origin: ORIGIN });
    expect(inv).toMatchObject({ notified: true, maskedName: "Ra**** Ku***" });
    expect(inv.expiresIst).toMatch(/ IST$/);
    expect(inv.share.whatsapp).toMatch(/^https:\/\/wa\.me\/\?text=/);
    const [n] = await db.select().from(notifications).where(and(eq(notifications.userId, p.id), eq(notifications.type, "dealer.team_invitation")));
    expect(n.actionUrl).toBe("/team/invitations");
    // Not yet a member.
    expect((await listMarketplaceRoles(p.id)).roles).toEqual(["customer"]);
    expect(await db.select().from(dealerSalespeople)).toHaveLength(0);
    const mine = await listMyTeamInvitations(p.actor);
    expect(mine.invitations).toHaveLength(1);
    expect(mine.invitations[0]).toMatchObject({ dealerName: "Shree Sai Network", role: "TEAM_LEAD" });
    expect(mine.missing).toEqual([]);
    await expect(inviteTeamMember(actor, { contact: p.email, role: "AGENT", origin: ORIGIN })).rejects.toThrow(/already has a request waiting/);

    const res = await respondToTeamInvitation(p.actor, inv.invitationId, true);
    const [m] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, res.salespersonId!));
    expect(m).toMatchObject({ dealerId: dealer.id, userId: p.id, teamRole: "TEAM_LEAD", depth: 2, parentId: null, status: "ACTIVE" });
    expect(m.employeeId).toMatch(/^GK-[0-9A-F]{8}$/);
    expect((await listMarketplaceRoles(p.id)).roles).toEqual(["customer", "team_lead"]);
    const overview = await teamOverview(actor);
    expect(overview.members[0].code).toMatch(/^GKT/);
    expect(overview.members[0].payoutMissing).toEqual(expect.arrayContaining(["PAN", "verified bank account"]));
    expect((await history(p.id)).map((h) => [h.role, h.action, h.toValue])).toEqual([["team_lead", "GRANTED", "TEAM_LEAD under the dealer"]]);
    expect(await db.select().from(dealerTeamMappingHistory).where(eq(dealerTeamMappingHistory.memberId, m.id))).toHaveLength(1);
    await expect(respondToTeamInvitation(p.actor, inv.invitationId, true)).rejects.toThrow(/already accepted/);
    await expect(searchTeamCandidate(actor, mobileOf(p))).resolves.toMatchObject({ state: "IN_YOUR_TEAM" });
  });

  it("an agent goes under the dealer or under one of his team leads", async () => {
    const { actor } = await newDealer();
    const lead = await join(actor, await customer("Lead One"), "TEAM_LEAD");
    const direct = await join(actor, await customer("Agent Direct"), "AGENT");
    const under = await join(actor, await customer("Agent Under"), "AGENT", lead.id);
    expect(direct).toMatchObject({ teamRole: "AGENT", depth: 2, parentId: null });
    expect(under).toMatchObject({ teamRole: "AGENT", depth: 3, parentId: lead.id, parentRole: "TEAM_LEAD" });
    // A team lead reports to the dealer; an agent cannot be a parent.
    await expect(inviteTeamMember(actor, { contact: mobileOf(await customer("X")), role: "TEAM_LEAD", parentId: lead.id, origin: ORIGIN })).rejects.toThrow(/reports to the dealer/);
    await expect(inviteTeamMember(actor, { contact: mobileOf(await customer("Y")), role: "AGENT", parentId: direct.id, origin: ORIGIN })).rejects.toThrow(/not an active team lead/);
  });

  it("a team lead adds agents under himself while rule teamLeadsCanAddAgents is on; off → refused", async () => {
    const { actor } = await newDealer();
    const leadPerson = await customer("Lead One");
    const lead = await join(actor, leadPerson, "TEAM_LEAD");
    const other = await join(actor, await customer("Lead Two"), "TEAM_LEAD");
    const p = await customer("New Agent");
    await expect(inviteTeamMember(leadPerson.actor, { contact: mobileOf(p), role: "TEAM_LEAD", origin: ORIGIN })).rejects.toThrow(/adds agents only/);
    // The parent is always the lead himself, whatever was sent.
    const inv = await inviteTeamMember(leadPerson.actor, { contact: mobileOf(p), role: "AGENT", parentId: other.id, origin: ORIGIN });
    const res = await respondToTeamInvitation(p.actor, inv.invitationId, true);
    const [m] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, res.salespersonId!));
    expect(m).toMatchObject({ parentId: lead.id, depth: 3 });
    const leadView = await teamOverview(leadPerson.actor);
    expect(leadView).toMatchObject({ viewer: "TEAM_LEAD", canAddLeads: false, canAddAgents: true });
    expect(leadView.members.map((x) => x.id)).toEqual([m.id]);
    // Role changes stay the dealer's.
    await expect(upgradeToTeamLead(leadPerson.actor, m.id)).rejects.toThrow(/Only the dealer/);

    await setRule("onboardingV2", { ...RULES.onboardingV2.defaults, teamLeadsCanAddAgents: false }, admin);
    clearRuleCache();
    await expect(inviteTeamMember(leadPerson.actor, { contact: mobileOf(await customer("Another")), role: "AGENT", origin: ORIGIN })).rejects.toThrow(/cannot add agents/);
    expect((await teamOverview(leadPerson.actor)).canAddAgents).toBe(false);
    // An agent can never add anyone.
    await expect(inviteTeamMember(p.actor, { contact: mobileOf(await customer("Z")), role: "AGENT", origin: ORIGIN })).rejects.toThrow(/approved dealer or one of his team leads/);
  });
});

describe("invite link for someone without an account", () => {
  it("signs up, opens the link, then accepts; a different account cannot use the link", async () => {
    const { actor } = await newDealer();
    const inv = await inviteTeamMember(actor, { contact: "new.person@example.com", role: "AGENT", origin: ORIGIN });
    expect(inv).toMatchObject({ notified: false, maskedName: null });
    expect(inv.link).toMatch(new RegExp(`^${ORIGIN}/team/join/[A-Za-z0-9_-]{32}$`));
    const token = inv.link.split("/").pop()!;
    const [row] = await db.select().from(teamInvitations).where(eq(teamInvitations.id, inv.invitationId));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toContain(token);

    const stranger = await customer("Stranger");
    await expect(claimTeamInvitation(stranger.actor, token)).rejects.toThrow(/another mobile number or e-mail/);

    // The person signs up with the invited e-mail (verified e-mail + mobile).
    const u = await createUser({ email: "new.person@example.com", name: "New Person" });
    await db.update(users).set({ emailVerified: new Date(), phoneVerifiedAt: new Date() }).where(eq(users.id, u.id));
    const person = { id: u.id, role: u.role };
    expect(await claimTeamInvitation(person, token)).toEqual({ invitationId: inv.invitationId });
    expect((await listMyTeamInvitations(person)).invitations.map((i) => i.id)).toEqual([inv.invitationId]);
    await expect(claimTeamInvitation(stranger.actor, token)).rejects.toThrow(/another GoKesari account/);
    const res = await respondToTeamInvitation(person, inv.invitationId, true);
    expect(res.status).toBe("ACCEPTED");
    expect((await listMarketplaceRoles(u.id)).roles).toEqual(["customer", "agent"]);
  });

  it("an expired link is refused and marked EXPIRED", async () => {
    const { actor } = await newDealer();
    const p = await customer("Late Person");
    const inv = await inviteTeamMember(actor, { contact: mobileOf(p), role: "AGENT", origin: ORIGIN });
    await db.update(teamInvitations).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(teamInvitations.id, inv.invitationId));
    await expect(claimTeamInvitation(p.actor, inv.link.split("/").pop()!)).rejects.toThrow(/expired/);
    await expect(respondToTeamInvitation(p.actor, inv.invitationId, true)).rejects.toThrow(/expired/);
    const [row] = await db.select().from(teamInvitations).where(eq(teamInvitations.id, inv.invitationId));
    expect(row.status).toBe("EXPIRED");
    expect((await listMyTeamInvitations(p.actor)).invitations).toHaveLength(0);
    expect(await db.select().from(dealerSalespeople)).toHaveLength(0);
  });

  it("the invite link lasts teamInviteExpiryDays", async () => {
    const { actor } = await newDealer();
    await setRule("onboardingV2", { ...RULES.onboardingV2.defaults, teamInviteExpiryDays: 3 }, admin);
    clearRuleCache();
    const inv = await inviteTeamMember(actor, { contact: "nobody@example.com", role: "TEAM_LEAD", origin: ORIGIN });
    const days = (inv.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.99);
    expect(days).toBeLessThan(3.01);
  });
});

describe("decline, cancel and readiness", () => {
  it("decline: no role, the dealer is told; cancel: the request is withdrawn", async () => {
    const { dealer, actor } = await newDealer();
    const p = await customer("Ramesh Kumar");
    const inv = await inviteTeamMember(actor, { contact: mobileOf(p), role: "AGENT", origin: ORIGIN });
    expect(await respondToTeamInvitation(p.actor, inv.invitationId, false)).toEqual({ status: "DECLINED", salespersonId: null });
    expect(await db.select().from(dealerSalespeople)).toHaveLength(0);
    expect((await listMarketplaceRoles(p.id)).roles).toEqual(["customer"]);
    const told = await db.select().from(notifications).where(and(eq(notifications.userId, dealer.userId!), eq(notifications.type, "dealer.team_changed")));
    expect(told[0].body).toMatch(/declined/);
    const again = await inviteTeamMember(actor, { contact: mobileOf(p), role: "AGENT", origin: ORIGIN });
    await cancelTeamInvitation(actor, again.invitationId);
    await expect(respondToTeamInvitation(p.actor, again.invitationId, true)).rejects.toThrow(/withdrew/);
  });

  it("someone without a verified e-mail cannot accept until it is added", async () => {
    const { actor } = await newDealer();
    const p = await customer("Not Ready", false);
    const inv = await inviteTeamMember(actor, { contact: mobileOf(p), role: "AGENT", origin: ORIGIN });
    expect((await listMyTeamInvitations(p.actor)).missing).toEqual(["a verified e-mail address"]);
    await expect(respondToTeamInvitation(p.actor, inv.invitationId, true)).rejects.toThrow(/verified e-mail/);
    await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, p.id));
    expect((await respondToTeamInvitation(p.actor, inv.invitationId, true)).status).toBe("ACCEPTED");
  });
});

describe("role changes (dealer only), each in the history", () => {
  it("upgrade an agent; downgrade a lead only after his agents are reassigned; remove → customer; rejoin reuses the row", async () => {
    const { actor } = await newDealer();
    const leadP = await customer("Lead One");
    const agentP = await customer("Agent One");
    const lead = await join(actor, leadP, "TEAM_LEAD");
    const agent = await join(actor, agentP, "AGENT", lead.id);
    const other = await join(actor, await customer("Agent Two"), "AGENT");

    await upgradeToTeamLead(actor, other.id);
    expect((await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, other.id)))[0]).toMatchObject({ teamRole: "TEAM_LEAD", depth: 2 });

    await expect(downgradeToAgent(actor, lead.id, {})).rejects.toThrow(/still leads 1 agent/);
    await reassignAgent(actor, agent.id, { parentId: other.id });
    await reassignAgent(actor, agent.id, { parentId: null });
    await downgradeToAgent(actor, lead.id, { parentId: other.id });
    expect((await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, lead.id)))[0]).toMatchObject({ teamRole: "AGENT", depth: 3, parentId: other.id });
    expect((await listMarketplaceRoles(leadP.id)).roles).toEqual(["customer", "agent"]);

    await removeTeamRole(actor, agent.id);
    expect((await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, agent.id)))[0].status).toBe("INACTIVE");
    expect((await listMarketplaceRoles(agentP.id)).roles).toEqual(["customer"]);

    expect((await history(leadP.id)).map((h) => [h.role, h.action, h.fromValue, h.toValue])).toEqual([
      ["team_lead", "GRANTED", null, "TEAM_LEAD under the dealer"],
      ["agent", "DOWNGRADED", "team_lead", "agent under Agent Two"],
    ]);
    expect((await history(agentP.id)).map((h) => [h.action, h.fromValue, h.toValue])).toEqual([
      ["GRANTED", null, "AGENT under Lead One"],
      ["REASSIGNED", "agent under Lead One", "agent under Agent Two"],
      ["REASSIGNED", "agent under Agent Two", "agent under the dealer"],
      ["REVOKED", "agent", "customer"],
    ]);
    const overview = await teamOverview(actor);
    expect(overview.history.length).toBeGreaterThanOrEqual(8);
    expect(overview.history.every((h) => / (AM|PM) IST$/.test(h.atIst))).toBe(true);
    // Mapping history: agent One's places — under Lead One, under Agent Two, under the dealer.
    const places = await db.select().from(dealerTeamMappingHistory).where(eq(dealerTeamMappingHistory.memberId, agent.id)).orderBy(dealerTeamMappingHistory.validFrom);
    expect(places.map((p) => p.parentId)).toEqual([lead.id, other.id, null]);

    // Rejoin: the same row is reactivated, now as a team lead.
    const back = await join(actor, agentP, "TEAM_LEAD");
    expect(back.id).toBe(agent.id);
    expect(back).toMatchObject({ status: "ACTIVE", teamRole: "TEAM_LEAD", userId: agentP.id });
    expect((await listMarketplaceRoles(agentP.id)).roles).toEqual(["customer", "team_lead"]);
  });

  it("removing a team lead moves his agents under the dealer and records it", async () => {
    const { actor } = await newDealer();
    const leadP = await customer("Lead One");
    const agentP = await customer("Agent One");
    const lead = await join(actor, leadP, "TEAM_LEAD");
    const agent = await join(actor, agentP, "AGENT", lead.id);
    await removeTeamRole(actor, lead.id);
    expect((await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, agent.id)))[0]).toMatchObject({ parentId: null, depth: 2, status: "ACTIVE" });
    expect((await history(agentP.id)).at(-1)).toMatchObject({ action: "REASSIGNED", toValue: "agent under the dealer" });
    expect((await history(leadP.id)).at(-1)).toMatchObject({ action: "REVOKED", role: "team_lead" });
  });

  it("another dealer cannot touch the member; an admin overrides with a reason (OVERRIDE)", async () => {
    const { actor } = await newDealer();
    const { actor: otherDealer } = await newDealer("Other Network");
    const p = await customer("Agent One");
    const m = await join(actor, p, "AGENT");
    await expect(upgradeToTeamLead(otherDealer, m.id)).rejects.toThrow(/not found/i);
    await expect(adminOverrideTeamRole(otherDealer, p.id, { to: "TEAM_LEAD", reason: "trying" })).rejects.toThrow(/Only an admin/);
    await expect(adminOverrideTeamRole(admin, p.id, { to: "TEAM_LEAD", reason: "" })).rejects.toThrow(/Say why/);
    await adminOverrideTeamRole(admin, p.id, { to: "TEAM_LEAD", reason: "dealer asked by phone" });
    const view = await adminMarketplaceRoleView(p.id);
    expect(view.roles).toEqual(["customer", "team_lead"]);
    expect(view.history[0]).toMatchObject({ action: "OVERRIDE", role: "team_lead", fromValue: "agent", toValue: "team_lead" });
    expect(view.history[0].reason).toMatch(/admin override\): dealer asked by phone/);
    expect(view.history[0].atIst).toMatch(/ IST$/);
    await adminOverrideTeamRole(admin, p.id, { to: "REMOVE", reason: "left the company" });
    expect((await adminMarketplaceRoleView(p.id)).roles).toEqual(["customer"]);
  });
});

describe("accept is one transaction", () => {
  it("two dealers' requests accepted at the same moment: exactly one place, no orphan row", async () => {
    const { actor: d1 } = await newDealer("Network One");
    const { actor: d2 } = await newDealer("Network Two");
    const p = await customer("Popular Person");
    const i1 = await inviteTeamMember(d1, { contact: mobileOf(p), role: "AGENT", origin: ORIGIN });
    const i2 = await inviteTeamMember(d2, { contact: p.email, role: "TEAM_LEAD", origin: ORIGIN });
    const results = await Promise.allSettled([respondToTeamInvitation(p.actor, i1.invitationId, true), respondToTeamInvitation(p.actor, i2.invitationId, true)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(failed.reason)).toMatch(/already in a team/);
    expect(await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.userId, p.id))).toHaveLength(1);
    expect((await history(p.id)).filter((h) => h.action === "GRANTED")).toHaveLength(1);
    const statuses = (await db.select().from(teamInvitations)).map((i) => i.status).sort();
    expect(statuses).toEqual(["ACCEPTED", "PENDING"]);
  });

  it("a failure inside accept leaves nothing behind: no member row, no code, the request still waiting", async () => {
    const { dealer, actor } = await newDealer();
    const p = await customer("Same Mobile");
    const inv = await inviteTeamMember(actor, { contact: p.email, role: "AGENT", origin: ORIGIN });
    // The dealer's own mobile is the person's: addSalesperson refuses it (one mobile once in a team) after the locks.
    await db.update(dealers).set({ mobileE164: p.phoneE164 }).where(eq(dealers.id, dealer.id));
    await expect(respondToTeamInvitation(p.actor, inv.invitationId, true)).rejects.toThrow(/already in your team/);
    expect(await db.select().from(dealerSalespeople)).toHaveLength(0);
    expect((await db.select().from(teamInvitations).where(eq(teamInvitations.id, inv.invitationId)))[0].status).toBe("PENDING");
    expect(await history(p.id)).toHaveLength(0);
  });

  it("the database refuses a second ACTIVE place for one account (0219)", async () => {
    const { actor } = await newDealer();
    const { dealer: other } = await newDealer("Other Network");
    const p = await customer("Agent One");
    await join(actor, p, "AGENT");
    await expect(db.insert(dealerSalespeople).values({ dealerId: other.id, employeeId: "DUP-1", name: "Dup", userId: p.id })).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ commission */

async function signedShop(dealerId: string, signerId: string | null, basePaise = 499_900) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const gst = Math.round(basePaise * 0.18);
  const shop = await createShop(owner.id, { name: `Shop ${Math.random().toString(36).slice(2, 7)}`, status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: basePaise + gst });
  await db.update(shops).set({ registrationFeeBasePaise: basePaise, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: gst, phone: `9${Math.floor(100_000_000 + Math.random() * 899_999_999)}` }).where(eq(shops.id, shop.id));
  await db.insert(shopAttributions).values({ shopId: shop.id, dealerId, salespersonId: signerId, source: "CODE_AT_REGISTRATION", matchKind: "NONE" });
  await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: basePaise + gst, method: "ONLINE", transactionId: `cf_${shop.id.slice(0, 8)}` }, admin);
  for (const docType of ["PAN", "GSTIN", "SHOP_ACT"] as const) {
    await db.insert(sellerVerifications).values({ shopId: shop.id, docType, status: "VERIFIED", providerId: "mock", verifiedAt: new Date() });
  }
  await approveShop(shop.id, { classification: "KESARI" }, admin);
  return shop;
}

const ledger = async (shopId: string) =>
  (await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.shopId, shopId)))
    .sort((a, b) => a.entryType.localeCompare(b.entryType))
    .map((r) => [r.entryType, r.payeeMemberId, r.amountPaise]);

describe("commission: the v2 hierarchy is what placementFor / mappingAt read", () => {
  it("20% / 4% / 3% for a shop signed by an agent under a team lead under the dealer; after a reassignment only new shops change", async () => {
    const { dealer, actor } = await newDealer();
    const leadP = await customer("Ramesh Lead");
    const agentP = await customer("Agent Asha");
    const lead = await join(actor, leadP, "TEAM_LEAD");
    const agent = await join(actor, agentP, "AGENT", lead.id);
    // Agreement accepted (payee checks are not part of what is tested here).
    await db.update(dealerSalespeople).set({ agreementVersion: AGENT_AGREEMENT_VERSION, agreementAcceptedAt: new Date() }).where(eq(dealerSalespeople.dealerId, dealer.id));

    const shop = await signedShop(dealer.id, agent.id);
    const before = await ledger(shop.id);
    expect(before).toEqual([
      ["DIRECT_1", agent.id, 99_980],
      ["OVERRIDE_LEAD", lead.id, 19_996],
      ["OVERRIDE_MAIN", null, 14_997],
    ]);

    // The dealer moves the agent under himself: the next shop pays 20% + 4% (one level up), the first one is untouched.
    await new Promise((r) => setTimeout(r, 5));
    await reassignAgent(actor, agent.id, { parentId: null });
    const later = await signedShop(dealer.id, agent.id);
    expect(await ledger(later.id)).toEqual([
      ["DIRECT_1", agent.id, 99_980],
      ["OVERRIDE_MAIN", null, 19_996],
    ]);
    expect(await ledger(shop.id)).toEqual(before);
  });
});
