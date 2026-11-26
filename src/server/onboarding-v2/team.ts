/**
 * Onboarding v2, Flow 4 — "My team" (docs/onboarding-v2-2026-11; owner brief 26-Nov-2026 18.19 IST).
 *
 * A dealer (free dealer or paid franchisee) finds a registered customer by mobile or e-mail, picks the role
 * (team lead, or agent under himself or one of his team leads) and sends a request; the person accepts or declines.
 * Someone without an account gets an invite link (/team/join/<token>), signs up, and then accepts. Only on accept is
 * the place in the team created — the same dealer_salespeople row, code and mapping history the commission engine
 * (dealers/tiered.ts placementFor / mappingAt) already reads, so commission logic is untouched.
 *
 * Role changes are the dealer's (an admin may override): agent → team lead, team lead → agent once his agents are
 * reassigned, reassign an agent, remove (back to customer only). Each is written to onboarding_role_history (IST on
 * screen), the dealer team mapping history and the audit log. Past commission stays where it was earned; shops
 * signed later follow the new place (mappingAt by the shop's date).
 *
 * Everything here runs only while the onboarding_v2 flag is on.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, getTableColumns, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { maskEmail, maskPhone } from "@/lib/phone";
import { maskPersonName, parseTeamContact, teamInviteLink, teamInviteMessage, teamInviteShareLinks, type TeamContact } from "@/lib/onboarding-v2/team";
import { db, type DbClient } from "@/server/db";
import {
  dealerSalespeople,
  dealers,
  onboardingRoleHistory,
  teamInvitations,
  users,
  type Dealer,
  type DealerSalesperson,
  type MarketplaceRole,
  type RoleHistoryAction,
  type User,
  type UserRole,
} from "@/server/db/schema";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { payeeStatus } from "@/server/dealers/commission";
import { addSalespersonIn, getDealerForUser, listSalespeople, setSalespersonStatusIn } from "@/server/dealers/service";
import { getMemberForUser, placeNewMember, recordMapping } from "@/server/dealers/tiered";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { requireFeature } from "@/server/services/feature-flags";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { emailIsVerified, mobileState } from "./customer";
import { ONBOARDING_V2_FLAG, formatIstStamp, listMarketplaceRoles, recordRoleChange } from "./roles";

export interface TeamActor {
  id: string;
  role: UserRole;
}

type TeamRole = "TEAM_LEAD" | "AGENT";

/** 404 "not available" unless the onboarding_v2 flag is on (flag off = exactly today's dealer team). */
export function requireOnboardingV2(): Promise<void> {
  return requireFeature(ONBOARDING_V2_FLAG);
}

export const hashInviteToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/* ============================================================== who acts */

export interface TeamContext {
  dealer: Dealer;
  /** Set when a team lead (not the dealer) is acting: he may add agents under himself only. */
  lead: DealerSalesperson | null;
}

/** The approved dealer behind the signed-in user, or the team lead acting for his own agents. */
export async function teamContextFor(userId: string): Promise<TeamContext> {
  const dealer = await getDealerForUser(userId);
  if (dealer && dealer.status === "APPROVED") return { dealer, lead: null };
  const mine = await getMemberForUser(userId);
  if (mine && mine.dealer.status === "APPROVED" && mine.member.teamRole === "TEAM_LEAD") return { dealer: mine.dealer, lead: mine.member };
  throw forbidden("Only an approved dealer or one of his team leads can manage a team.");
}

/* ============================================================ eligibility */

type CustomerRow = User;

const customerColumns = getTableColumns(users);

async function findCustomer(contact: TeamContact, client: DbClient = db): Promise<CustomerRow | null> {
  const [row] = await client
    .select(customerColumns)
    .from(users)
    .where(and(isNull(users.deletedAt), contact.kind === "email" ? sql`lower(${users.email}) = ${contact.email}` : eq(users.phoneE164, contact.e164)))
    .limit(1);
  return row ?? null;
}

/**
 * What a person still needs before they can join a team: a registered customer with a verified e-mail and a
 * mobile — exactly what the v2 checkout sheet asks (onboarding-v2/customer.ts): e-mail verified by link / code or a
 * linked Google account; mobile SMS-verified, or (no SMS on the site and rule mobileOtpFallbackWhenNoSms on) saved.
 */
export async function customerReadiness(user: CustomerRow): Promise<string[]> {
  const missing: string[] = [];
  if (user.status !== "ACTIVE") missing.push("an active account");
  if (!(await emailIsVerified(user))) missing.push("a verified e-mail address");
  if (!user.phoneE164) missing.push("a mobile number");
  else if (!(await mobileState(user)).done) missing.push("a verified mobile number");
  return missing;
}

async function activeMemberOf(userId: string, client: DbClient = db) {
  const [row] = await client
    .select({ id: dealerSalespeople.id, dealerId: dealerSalespeople.dealerId })
    .from(dealerSalespeople)
    .where(and(eq(dealerSalespeople.userId, userId), eq(dealerSalespeople.status, "ACTIVE")))
    .limit(1);
  return row ?? null;
}

async function ownsDealer(userId: string, client: DbClient = db): Promise<boolean> {
  const [row] = await client.select({ id: dealers.id }).from(dealers).where(and(eq(dealers.userId, userId), ne(dealers.status, "REJECTED"))).limit(1);
  return Boolean(row);
}

/* ================================================================= search */

export type CandidateState = "AVAILABLE" | "SELF" | "IN_YOUR_TEAM" | "ALREADY_INVITED";

/**
 * found:false is the one answer for "no account", "account not complete", "a dealer" and "in another team" — a
 * search must not tell a dealer which of those it is (enumeration). He can still send an invite link; the person
 * sees it on their own account.
 */
export type CandidateView =
  | { found: false; contact: string }
  | { found: true; contact: string; maskedName: string; state: CandidateState };

const contactLabel = (c: TeamContact) => (c.kind === "email" ? maskEmail(c.email) : maskPhone(c.e164));

/** Exact search by mobile or e-mail (mandatory). Shows only a masked name, and only for someone who can be added. */
export async function searchTeamCandidate(actor: TeamActor, query: string): Promise<CandidateView> {
  await requireOnboardingV2();
  const ctx = await teamContextFor(actor.id);
  enforceRateLimit(`team-search:${ctx.dealer.id}`, RATE_LIMITS.TEAM_SEARCH_DEALER);
  const contact = parseTeamContact(query);
  if (!contact) throw validationFailed("Enter the person's 10-digit mobile number or e-mail address.", { fields: { query: "Mobile or e-mail." } });
  const user = await findCustomer(contact);
  const none = { found: false as const, contact: contactLabel(contact) };
  if (!user) return none;
  const shown = (state: CandidateState): CandidateView => ({ found: true, contact: contactLabel(contact), maskedName: maskPersonName(user.name), state });
  if (user.id === actor.id) return shown("SELF");
  const member = await activeMemberOf(user.id);
  if (member?.dealerId === ctx.dealer.id) return shown("IN_YOUR_TEAM");
  if (member || (await ownsDealer(user.id)) || (await customerReadiness(user)).length) return none;
  if (await pendingInviteFor(ctx.dealer.id, { userId: user.id, contact })) return shown("ALREADY_INVITED");
  return shown("AVAILABLE");
}

/** The same answer for "a dealer" and "in another team" (enumeration). */
const CANNOT_ADD = "This person cannot be added to your team.";

async function pendingInviteFor(dealerId: string, who: { userId: string | null; contact: TeamContact }): Promise<boolean> {
  const byContact = who.contact.kind === "email" ? sql`lower(${teamInvitations.inviteeEmail}) = ${who.contact.email}` : eq(teamInvitations.inviteeMobileE164, who.contact.e164);
  const [row] = await db
    .select({ id: teamInvitations.id })
    .from(teamInvitations)
    .where(
      and(
        eq(teamInvitations.dealerId, dealerId),
        eq(teamInvitations.status, "PENDING"),
        sql`${teamInvitations.expiresAt} > now()`,
        who.userId ? or(eq(teamInvitations.inviteeUserId, who.userId), byContact) : byContact,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/* ================================================================= invite */

async function requireLead(client: DbClient, dealerId: string, leadId: string): Promise<DealerSalesperson> {
  const [lead] = await client.select().from(dealerSalespeople).where(and(eq(dealerSalespeople.id, leadId), eq(dealerSalespeople.dealerId, dealerId)));
  if (!lead) throw notFound("Team lead");
  if (lead.teamRole !== "TEAM_LEAD" || lead.status !== "ACTIVE") throw conflict("That person is not an active team lead of this team.", { fields: { parentId: "Choose a team lead." } });
  return lead;
}

export const TEAM_INVITES_PER_DEALER_PER_DAY = 20;

export interface InviteResult {
  invitationId: string;
  /** True when the person already has an account: they got the request in the app, by e-mail and SMS. */
  notified: boolean;
  maskedName: string | null;
  link: string;
  message: string;
  share: { whatsapp: string; sms: string; email: string };
  expiresAt: Date;
  expiresIst: string;
}

/**
 * Sends a team request. role is mandatory; an AGENT reports to the dealer directly (parentId null) or to one of
 * his team leads. A team lead acting himself may add AGENTs under himself only, while rule
 * onboardingV2.teamLeadsCanAddAgents is on (default #5).
 */
export async function inviteTeamMember(
  actor: TeamActor,
  input: { contact: string; role: TeamRole; parentId?: string | null; origin: string },
): Promise<InviteResult> {
  await requireOnboardingV2();
  const ctx = await teamContextFor(actor.id);
  const rule = await getRule("onboardingV2");
  let role = input.role;
  let parentId = input.parentId ?? null;
  if (!role) throw validationFailed("Choose the role: team lead or agent.", { fields: { role: "Required." } });
  if (ctx.lead) {
    if (!rule.teamLeadsCanAddAgents) throw forbidden("Team leads cannot add agents at present; ask your dealer.");
    if (role !== "AGENT") throw forbidden("A team lead adds agents only.");
    role = "AGENT";
    parentId = ctx.lead.id;
  }
  if (role === "TEAM_LEAD" && parentId) throw validationFailed("A team lead reports to the dealer directly.", { fields: { parentId: "Leave empty." } });
  const parent = role === "AGENT" && parentId ? await requireLead(db, ctx.dealer.id, parentId) : null;

  const contact = parseTeamContact(input.contact);
  if (!contact) throw validationFailed("Enter the person's 10-digit mobile number or e-mail address.", { fields: { contact: "Mobile or e-mail." } });
  const user = await findCustomer(contact);
  if (user) {
    if (user.id === actor.id || user.id === ctx.dealer.userId) throw conflict("You cannot invite yourself.");
    const member = await activeMemberOf(user.id);
    if (member?.dealerId === ctx.dealer.id) throw conflict("This person is already in your team.");
    if (member || (await ownsDealer(user.id))) throw conflict(CANNOT_ADD);
  }
  // DEFAULT – confirm with Sanjay: at most 20 team requests a day per dealer (team leads' count too), counted here.
  const [{ sent }] = await db
    .select({ sent: sql<number>`count(*)::int` })
    .from(teamInvitations)
    .where(and(eq(teamInvitations.dealerId, ctx.dealer.id), sql`${teamInvitations.createdAt} > now() - interval '24 hours'`));
  if (sent >= TEAM_INVITES_PER_DEALER_PER_DAY) throw new AppError("RATE_LIMITED", `Your team can send ${TEAM_INVITES_PER_DEALER_PER_DAY} requests a day. Try again tomorrow.`, { retryAfterSeconds: 3600 });
  if (await pendingInviteFor(ctx.dealer.id, { userId: user?.id ?? null, contact })) throw conflict("This person already has a request waiting. Cancel it first to send a new one.");

  const token = randomBytes(24).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + rule.teamInviteExpiryDays * 86_400_000);
  const [inv] = await db
    .insert(teamInvitations)
    .values({
      dealerId: ctx.dealer.id,
      invitedByUserId: actor.id,
      invitedBySalespersonId: ctx.lead?.id ?? null,
      inviteeUserId: user?.id ?? null,
      inviteeMobileE164: contact.kind === "mobile" ? contact.e164 : (user?.phoneE164 ?? null),
      inviteeEmail: contact.kind === "email" ? contact.email : (user?.email.toLowerCase() ?? null),
      role,
      parentSalespersonId: parent?.id ?? null,
      tokenHash: hashInviteToken(token),
      channels: user ? ["IN_APP", "EMAIL", "SMS", "LINK"] : ["LINK"],
      createdAt: now,
      expiresAt,
    })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DEALER_TEAM_CHANGED,
    entityType: "team_invitation",
    entityId: inv.id,
    newValue: { dealerId: ctx.dealer.id, role, parentId: parent?.id ?? null, inviteeUserId: user?.id ?? null, contact: contactLabel(contact), status: "PENDING", expiresAt: expiresAt.toISOString(), byLead: ctx.lead?.id ?? null },
  });
  const expiresIst = formatIstStamp(expiresAt);
  // The person is told in the app whatever the state of their account; the dealer sees a name only for someone
  // the search would show too (ready to join), so the reply does not reveal an incomplete account.
  const revealed = user ? (await customerReadiness(user)).length === 0 : false;
  if (user) {
    await notify({
      userId: user.id,
      type: NOTIFICATION_TYPES.DEALER_TEAM_INVITATION,
      vars: { dealerName: ctx.dealer.legalName, role: role === "TEAM_LEAD" ? "a team lead" : `an agent${parent ? ` under ${parent.name}` : ""}`, expires: expiresIst },
      actionUrl: "/team/invitations",
      channels: ["EMAIL", "SMS"],
      dedupeKey: `team-invite:${inv.id}`,
    });
  }
  const link = teamInviteLink(input.origin, token);
  const message = teamInviteMessage({ dealerName: ctx.dealer.legalName, role, link, expiresIst });
  return { invitationId: inv.id, notified: revealed, maskedName: revealed && user ? maskPersonName(user.name) : null, link, message, share: teamInviteShareLinks(message), expiresAt, expiresIst };
}

/** The dealer (or the team lead who sent it) withdraws a request that is still waiting. */
export async function cancelTeamInvitation(actor: TeamActor, invitationId: string): Promise<void> {
  await requireOnboardingV2();
  const ctx = await teamContextFor(actor.id);
  const [inv] = await db.select().from(teamInvitations).where(and(eq(teamInvitations.id, invitationId), eq(teamInvitations.dealerId, ctx.dealer.id)));
  if (!inv || (ctx.lead && inv.invitedBySalespersonId !== ctx.lead.id)) throw notFound("Invitation");
  const done = await db
    .update(teamInvitations)
    .set({ status: "CANCELLED", decidedAt: new Date() })
    .where(and(eq(teamInvitations.id, invitationId), eq(teamInvitations.status, "PENDING")))
    .returning({ id: teamInvitations.id });
  if (!done.length) throw conflict("This request is no longer waiting.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TEAM_CHANGED, entityType: "team_invitation", entityId: invitationId, previousValue: { status: "PENDING" }, newValue: { status: "CANCELLED" } });
}

/* ========================================================== the invitee */

/** Marks requests whose link ran out as EXPIRED (on read; nothing else depends on it). */
async function expireStale(where = sql`true`): Promise<void> {
  await db
    .update(teamInvitations)
    .set({ status: "EXPIRED", decidedAt: new Date() })
    .where(and(eq(teamInvitations.status, "PENDING"), lt(teamInvitations.expiresAt, new Date()), where));
}

/**
 * /team/join/<token> after sign-in: ties an invite link to the signed-in account, which then sees it on
 * /team/invitations. DEFAULT – confirm with Sanjay: the account must carry the mobile number or e-mail the dealer
 * typed (a forwarded link cannot be used by someone else).
 */
export async function claimTeamInvitation(actor: TeamActor, token: string): Promise<{ invitationId: string }> {
  await requireOnboardingV2();
  const clean = (token ?? "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(clean)) throw notFound("Invitation");
  const [inv] = await db.select().from(teamInvitations).where(eq(teamInvitations.tokenHash, hashInviteToken(clean)));
  if (!inv) throw notFound("Invitation");
  if (inv.status === "PENDING" && inv.expiresAt.getTime() <= Date.now()) {
    await expireStale(eq(teamInvitations.id, inv.id));
    throw conflict("This invitation has expired. Ask the dealer to send a new one.", { reason: "EXPIRED" });
  }
  if (inv.status !== "PENDING") throw conflict(STATUS_MESSAGE[inv.status] ?? "This invitation is closed.", { reason: inv.status });
  if (inv.inviteeUserId) {
    if (inv.inviteeUserId !== actor.id) throw forbidden("This invitation is for another GoKesari account.");
    return { invitationId: inv.id };
  }
  const [me] = await db.select({ email: users.email, phoneE164: users.phoneE164 }).from(users).where(eq(users.id, actor.id));
  if (!me) throw notFound("Account");
  const matches = (inv.inviteeEmail && me.email.toLowerCase() === inv.inviteeEmail.toLowerCase()) || (inv.inviteeMobileE164 && me.phoneE164 === inv.inviteeMobileE164);
  if (!matches) throw forbidden("This invitation was sent to another mobile number or e-mail. Sign in with that one, or add it to your account first.");
  const claimed = await db
    .update(teamInvitations)
    .set({ inviteeUserId: actor.id })
    .where(and(eq(teamInvitations.id, inv.id), isNull(teamInvitations.inviteeUserId), eq(teamInvitations.status, "PENDING")))
    .returning({ id: teamInvitations.id });
  if (!claimed.length) throw conflict("This invitation is no longer open.");
  return { invitationId: inv.id };
}

const STATUS_MESSAGE: Record<string, string> = {
  ACCEPTED: "This invitation was already accepted.",
  DECLINED: "This invitation was declined.",
  CANCELLED: "The dealer withdrew this invitation.",
  EXPIRED: "This invitation has expired. Ask the dealer to send a new one.",
};

export interface InvitationView {
  id: string;
  dealerName: string;
  role: TeamRole;
  parentName: string | null;
  invitedBy: string;
  createdIst: string;
  expiresIst: string;
}

/** The signed-in person's waiting requests (/team/invitations). */
export async function listMyTeamInvitations(actor: TeamActor): Promise<{ invitations: InvitationView[]; missing: string[] }> {
  await requireOnboardingV2();
  await expireStale(eq(teamInvitations.inviteeUserId, actor.id));
  const rows = await db
    .select({ inv: teamInvitations, dealerName: dealers.legalName })
    .from(teamInvitations)
    .innerJoin(dealers, eq(dealers.id, teamInvitations.dealerId))
    .where(and(eq(teamInvitations.inviteeUserId, actor.id), eq(teamInvitations.status, "PENDING")))
    .orderBy(desc(teamInvitations.createdAt));
  const parentIds = rows.map((r) => r.inv.parentSalespersonId).filter((v): v is string => Boolean(v));
  const inviterIds = [...new Set(rows.map((r) => r.inv.invitedByUserId))];
  const [parents, inviters] = await Promise.all([
    parentIds.length ? db.select({ id: dealerSalespeople.id, name: dealerSalespeople.name }).from(dealerSalespeople).where(inArray(dealerSalespeople.id, parentIds)) : [],
    inviterIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, inviterIds)) : [],
  ]);
  const [me] = await db.select(customerColumns).from(users).where(eq(users.id, actor.id));
  return {
    invitations: rows.map((r) => ({
      id: r.inv.id,
      dealerName: r.dealerName,
      role: r.inv.role,
      parentName: parents.find((p) => p.id === r.inv.parentSalespersonId)?.name ?? null,
      invitedBy: inviters.find((u) => u.id === r.inv.invitedByUserId)?.name ?? r.dealerName,
      createdIst: formatIstStamp(r.inv.createdAt),
      expiresIst: formatIstStamp(r.inv.expiresAt),
    })),
    missing: me ? await customerReadiness(me) : [],
  };
}

export const marketplaceRoleOf = (role: TeamRole): MarketplaceRole => (role === "TEAM_LEAD" ? "team_lead" : "agent");

/**
 * The person accepts (the place in the team is created now) or declines. Accept: an earlier place of theirs in
 * the same team is reactivated, otherwise a new member row is created through addSalesperson (auto employee ID,
 * a GKT / GKA code as today) and placed under the chosen lead; the account is linked to it.
 */
export async function respondToTeamInvitation(actor: TeamActor, invitationId: string, accept: boolean): Promise<{ status: "ACCEPTED" | "DECLINED"; salespersonId: string | null }> {
  await requireOnboardingV2();
  const [inv] = await db.select().from(teamInvitations).where(and(eq(teamInvitations.id, invitationId), eq(teamInvitations.inviteeUserId, actor.id)));
  if (!inv) throw notFound("Invitation");
  if (inv.status === "PENDING" && inv.expiresAt.getTime() <= Date.now()) {
    await expireStale(eq(teamInvitations.id, inv.id));
    throw conflict(STATUS_MESSAGE.EXPIRED, { reason: "EXPIRED" });
  }
  if (inv.status !== "PENDING") throw conflict(STATUS_MESSAGE[inv.status] ?? "This invitation is closed.", { reason: inv.status });
  const [dealer] = await db.select().from(dealers).where(eq(dealers.id, inv.dealerId));
  if (!dealer) throw notFound("Dealer");

  if (!accept) {
    const done = await db
      .update(teamInvitations)
      .set({ status: "DECLINED", decidedAt: new Date() })
      .where(and(eq(teamInvitations.id, inv.id), eq(teamInvitations.status, "PENDING")))
      .returning({ id: teamInvitations.id });
    if (!done.length) throw conflict("This invitation is no longer open.");
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TEAM_CHANGED, entityType: "team_invitation", entityId: inv.id, previousValue: { status: "PENDING" }, newValue: { status: "DECLINED" } });
    const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, actor.id));
    await notify({ userId: inv.invitedByUserId, type: NOTIFICATION_TYPES.DEALER_TEAM_CHANGED, vars: { message: `${maskPersonName(me?.name)} declined your request to join the team.` }, actionUrl: "/dealer/team" });
    return { status: "DECLINED", salespersonId: null };
  }

  if (dealer.status !== "APPROVED") throw conflict("This dealer is not active at present.");
  const [me] = await db.select().from(users).where(eq(users.id, actor.id));
  if (!me) throw notFound("Account");
  const missing = await customerReadiness(me);
  if (missing.length) throw conflict(`Before you can join a team your account needs ${missing.join(" and ")}. Add it on your profile, then accept.`, { reason: "NOT_READY", missing });

  const memberActor = { id: actor.id, role: actor.role };
  // One transaction: the place, the code, the link to the account, the invitation and the history commit together
  // or not at all. Advisory locks on the account and the invitation serialise concurrent accepts (two invitations
  // from two dealers, or a double tap); every check is repeated under them.
  // DEFAULT – confirm with Sanjay: v2 keeps one ACTIVE team per account; the older admin path still allows
  // one person in two networks (dealer-payouts DP-2), so there is no database-wide unique index.
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`team-accept-user:${actor.id}`}))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`team-accept-invite:${inv.id}`}))`);
    const [cur] = await tx.select().from(teamInvitations).where(eq(teamInvitations.id, inv.id)).for("update");
    if (!cur || cur.inviteeUserId !== actor.id) throw notFound("Invitation");
    if (cur.status === "PENDING" && cur.expiresAt.getTime() <= Date.now()) return { expired: true as const };
    if (cur.status !== "PENDING") throw conflict(STATUS_MESSAGE[cur.status] ?? "This invitation is closed.", { reason: cur.status });
    const [d] = await tx.select().from(dealers).where(eq(dealers.id, cur.dealerId)).for("update");
    if (!d || d.status !== "APPROVED") throw conflict("This dealer is not active at present.");
    if (await ownsDealer(actor.id, tx)) throw conflict("A dealer cannot join another team.");
    if (await activeMemberOf(actor.id, tx)) throw conflict("You are already in a team. Leave it before joining another.");
    const parent = cur.role === "AGENT" && cur.parentSalespersonId ? await requireLead(tx, d.id, cur.parentSalespersonId).catch(() => null) : null;
    if (cur.role === "AGENT" && cur.parentSalespersonId && !parent) throw conflict("The team lead you were to report to has changed. Ask the dealer to send a new request.");

    // An earlier place of this person in the same team (removed before) is reactivated, keeping its code and payee details.
    const [previous] = await tx
      .select()
      .from(dealerSalespeople)
      .where(and(eq(dealerSalespeople.dealerId, d.id), eq(dealerSalespeople.userId, actor.id), eq(dealerSalespeople.status, "INACTIVE")))
      .orderBy(desc(dealerSalespeople.updatedAt))
      .limit(1);
    let memberId: string;
    if (previous) {
      await setSalespersonStatusIn(tx, d.id, previous.id, "ACTIVE", memberActor);
      memberId = previous.id;
      await clearChildren(tx, memberId, actor.id, "re-joined: earlier agents stay under the dealer");
      await placeNewMember(tx, d.id, memberId, cur.role, parent?.id ?? null, previous.recruitedById);
      await recordMapping(tx, memberId, "re-joined the team (invitation accepted)", actor.id);
    } else {
      // DEFAULT – confirm with Sanjay: the employee ID is generated (GK-<first 8 of the invitation>); the dealer sees it on My team.
      // No DEALER grant in user_role_grants (linkMemberAccount gives one): the team role is derived from this row
      // (roles.ts) and the member portal finds him through getMemberForUser.
      const mobile = me.phoneE164?.startsWith("+91") ? me.phoneE164.slice(3) : null;
      const created = await addSalespersonIn(
        tx,
        d.id,
        { employeeId: `GK-${cur.id.slice(0, 8).toUpperCase()}`, name: me.name?.trim() || me.email.split("@")[0], mobile, role: cur.role, parentId: parent?.id ?? null, userId: actor.id },
        memberActor,
      );
      memberId = created.id;
    }
    await tx.update(dealerSalespeople).set({ userId: actor.id, updatedAt: new Date() }).where(eq(dealerSalespeople.id, memberId));
    await tx.update(teamInvitations).set({ status: "ACCEPTED", decidedAt: new Date(), salespersonId: memberId }).where(eq(teamInvitations.id, cur.id));
    await recordRoleChange(
      {
        userId: actor.id,
        role: marketplaceRoleOf(cur.role),
        action: "GRANTED",
        toValue: parent ? `${cur.role} under ${parent.name}` : `${cur.role} under the dealer`,
        dealerId: d.id,
        salespersonId: memberId,
        actorUserId: actor.id,
        reason: `accepted the request of ${formatIstStamp(cur.createdAt)}`,
      },
      tx,
    );
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TEAM_CHANGED, entityType: "dealer_salesperson", entityId: memberId, previousValue: { invitation: cur.id, status: "PENDING" }, newValue: { status: "ACCEPTED", role: cur.role, parentId: parent?.id ?? null, userId: actor.id, reactivated: Boolean(previous) } },
      tx,
    );
    return { expired: false as const, memberId, parent };
  });
  if (outcome.expired) {
    await expireStale(eq(teamInvitations.id, inv.id));
    throw conflict(STATUS_MESSAGE.EXPIRED, { reason: "EXPIRED" });
  }
  const { memberId, parent } = outcome;
  const who = `${me.name?.trim() || "The person"} accepted and joined your team as ${inv.role === "TEAM_LEAD" ? "a team lead" : `an agent${parent ? ` under ${parent.name}` : ""}`}.`;
  for (const to of new Set([inv.invitedByUserId, dealer.userId].filter((v): v is string => Boolean(v)))) {
    await notify({ userId: to, type: NOTIFICATION_TYPES.DEALER_TEAM_CHANGED, vars: { message: who }, actionUrl: "/dealer/team", dedupeKey: `team-accepted:${inv.id}:${to}` });
  }
  return { status: "ACCEPTED", salespersonId: memberId };
}

/** Moves any (inactive) agents still pointing at `memberId` under the dealer, so its role can change. */
async function clearChildren(tx: DbClient, memberId: string, actorId: string, reason: string): Promise<string[]> {
  const moved = await tx
    .update(dealerSalespeople)
    .set({ depth: 2, parentId: null, parentDepth: null, parentRole: null, updatedAt: new Date() })
    .where(eq(dealerSalespeople.parentId, memberId))
    .returning({ id: dealerSalespeople.id });
  for (const m of moved) await recordMapping(tx, m.id, reason, actorId);
  return moved.map((m) => m.id);
}

/* ============================================================ role changes */

interface ChangeOptions {
  /** Admin override (Admin → user page): recorded as OVERRIDE, with a reason. */
  override?: boolean;
  reason?: string | null;
}

async function memberForChange(actor: TeamActor, memberId: string, opts: ChangeOptions): Promise<{ member: DealerSalesperson; dealer: Dealer }> {
  await requireOnboardingV2();
  const [member] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, memberId));
  if (opts.override) {
    if (actor.role !== "ADMIN") throw forbidden("Only an admin can override a team role.");
    if (!opts.reason || opts.reason.trim().length < 5) throw validationFailed("Say why you override the role.", { fields: { reason: "Required." } });
    if (!member) throw notFound("Team member");
    const [dealer] = await db.select().from(dealers).where(eq(dealers.id, member.dealerId));
    return { member, dealer };
  }
  const dealer = await getDealerForUser(actor.id);
  if (!dealer || dealer.status !== "APPROVED") throw forbidden("Only the dealer changes roles in his team.");
  if (!member || member.dealerId !== dealer.id) throw notFound("Team member");
  return { member, dealer };
}

const historyAction = (opts: ChangeOptions, action: RoleHistoryAction): RoleHistoryAction => (opts.override ? "OVERRIDE" : action);
const reasonOf = (opts: ChangeOptions, fallback: string) => (opts.override ? `${fallback} (admin override): ${opts.reason!.trim()}` : opts.reason?.trim() || fallback);

async function leadName(client: DbClient, id: string | null): Promise<string> {
  if (!id) return "the dealer";
  const [l] = await client.select({ name: dealerSalespeople.name }).from(dealerSalespeople).where(eq(dealerSalespeople.id, id));
  return l?.name ?? "a team lead";
}

async function tell(member: DealerSalesperson, message: string): Promise<void> {
  if (member.userId) await notify({ userId: member.userId, type: NOTIFICATION_TYPES.DEALER_TEAM_CHANGED, vars: { message }, actionUrl: "/dealer" });
}

/** Agent → team lead (reports to the dealer directly from now on). */
export async function upgradeToTeamLead(actor: TeamActor, memberId: string, opts: ChangeOptions = {}): Promise<DealerSalesperson> {
  const { member } = await memberForChange(actor, memberId, opts);
  // DEFAULT – confirm with Sanjay: the v2 upgrade is the dealer's own decision — the promotion minimums of the
  // TIERED rule (dealerPromotesAgent) are not checked and no development bonus is started for a former lead.
  const after = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, memberId)).for("update");
    if (before.status !== "ACTIVE") throw conflict("Only an active member can be upgraded.");
    if (before.teamRole !== "AGENT") throw conflict("This person is already a team lead.");
    const now = new Date();
    const [row] = await tx
      .update(dealerSalespeople)
      .set({ teamRole: "TEAM_LEAD", depth: 2, parentId: null, parentDepth: null, parentRole: null, promotedAt: now, updatedAt: now })
      .where(eq(dealerSalespeople.id, memberId))
      .returning();
    const why = reasonOf(opts, "upgraded to team lead");
    await recordMapping(tx, memberId, `v2: ${why}`, actor.id, now);
    if (before.userId) {
      await recordRoleChange({ userId: before.userId, role: "team_lead", action: historyAction(opts, "UPGRADED"), fromValue: "agent", toValue: "team_lead", dealerId: before.dealerId, salespersonId: memberId, actorUserId: actor.id, reason: why }, tx);
    }
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TEAM_CHANGED, entityType: "dealer_salesperson", entityId: memberId, previousValue: { role: "AGENT", parentId: before.parentId }, newValue: { role: "TEAM_LEAD", parentId: null, v2: true, override: Boolean(opts.override), reason: why } },
      tx,
    );
    return row;
  });
  await tell(member, "You are now a team lead. Shops already registered keep their commission as it was.");
  return after;
}

/**
 * Team lead → agent, under the dealer (parentId null) or another team lead. Refused while he still has active
 * agents: the dealer reassigns them first (reassignAgent).
 */
export async function downgradeToAgent(actor: TeamActor, memberId: string, input: { parentId?: string | null }, opts: ChangeOptions = {}): Promise<DealerSalesperson> {
  const { member } = await memberForChange(actor, memberId, opts);
  const after = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, memberId)).for("update");
    if (before.status !== "ACTIVE") throw conflict("Only an active member can be changed.");
    if (before.teamRole !== "TEAM_LEAD") throw conflict("This person is already an agent.");
    const agents = await tx
      .select({ id: dealerSalespeople.id, name: dealerSalespeople.name })
      .from(dealerSalespeople)
      .where(and(eq(dealerSalespeople.parentId, memberId), eq(dealerSalespeople.status, "ACTIVE")));
    if (agents.length) {
      throw conflict(`${before.name} still leads ${agents.length} agent(s). Move them to yourself or another team lead first.`, { reason: "AGENTS_TO_REASSIGN", agents: agents.map((a) => a.id) });
    }
    const parentId = input.parentId ?? null;
    if (parentId === memberId) throw validationFailed("A member cannot report to themselves.");
    const parent = parentId ? await requireLead(tx, before.dealerId, parentId) : null;
    const why = reasonOf(opts, "changed to agent");
    // DEFAULT – confirm with Sanjay: his former agents who are no longer active move under the dealer silently.
    await clearChildren(tx, memberId, actor.id, `v2: former lead ${before.name} ${why}`);
    const now = new Date();
    const [row] = await tx
      .update(dealerSalespeople)
      .set({ teamRole: "AGENT", depth: parent ? 3 : 2, parentId: parent?.id ?? null, parentDepth: parent ? 2 : null, parentRole: parent ? "TEAM_LEAD" : null, updatedAt: now })
      .where(eq(dealerSalespeople.id, memberId))
      .returning();
    await recordMapping(tx, memberId, `v2: ${why}`, actor.id, now);
    if (before.userId) {
      await recordRoleChange({ userId: before.userId, role: "agent", action: historyAction(opts, "DOWNGRADED"), fromValue: "team_lead", toValue: `agent under ${parent?.name ?? "the dealer"}`, dealerId: before.dealerId, salespersonId: memberId, actorUserId: actor.id, reason: why }, tx);
    }
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TEAM_CHANGED, entityType: "dealer_salesperson", entityId: memberId, previousValue: { role: "TEAM_LEAD", parentId: null }, newValue: { role: "AGENT", parentId: parent?.id ?? null, v2: true, override: Boolean(opts.override), reason: why } },
      tx,
    );
    return row;
  });
  await tell(member, "You are now an agent. Shops already registered keep their commission as it was.");
  return after;
}

/** An agent moves under another team lead, or under the dealer directly (parentId null). */
export async function reassignAgent(actor: TeamActor, agentId: string, input: { parentId: string | null }, opts: ChangeOptions = {}): Promise<DealerSalesperson> {
  const { member } = await memberForChange(actor, agentId, opts);
  const result = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, agentId)).for("update");
    if (before.status !== "ACTIVE") throw conflict("Only an active member can be moved.");
    if (before.teamRole !== "AGENT") throw conflict("Only an agent can be moved under a team lead.");
    const parentId = input.parentId ?? null;
    if (parentId === agentId) throw validationFailed("A member cannot report to themselves.");
    if (parentId === before.parentId) throw conflict("The agent already reports there.");
    const parent = parentId ? await requireLead(tx, before.dealerId, parentId) : null;
    const now = new Date();
    const [row] = await tx
      .update(dealerSalespeople)
      .set({ depth: parent ? 3 : 2, parentId: parent?.id ?? null, parentDepth: parent ? 2 : null, parentRole: parent ? "TEAM_LEAD" : null, updatedAt: now })
      .where(eq(dealerSalespeople.id, agentId))
      .returning();
    const from = await leadName(tx, before.parentId);
    const to = parent?.name ?? "the dealer";
    const why = reasonOf(opts, `moved from ${from} to ${to}`);
    await recordMapping(tx, agentId, `v2: ${why}`, actor.id, now);
    if (before.userId) {
      await recordRoleChange({ userId: before.userId, role: "agent", action: historyAction(opts, "REASSIGNED"), fromValue: `agent under ${from}`, toValue: `agent under ${to}`, dealerId: before.dealerId, salespersonId: agentId, actorUserId: actor.id, reason: why }, tx);
    }
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_TEAM_CHANGED, entityType: "dealer_salesperson", entityId: agentId, previousValue: { parentId: before.parentId }, newValue: { parentId: parent?.id ?? null, v2: true, override: Boolean(opts.override), reason: why } },
      tx,
    );
    return { row, to };
  });
  await tell(member, `You now report to ${result.to}. Shops already registered keep their commission as it was.`);
  return result.row;
}

/**
 * Removes the person's team role: back to customer only. The member row turns INACTIVE (his code stops for new
 * shops; shops he brought stay his), a team lead's active agents move under the dealer (existing rule).
 */
export async function removeTeamRole(actor: TeamActor, memberId: string, opts: ChangeOptions = {}): Promise<void> {
  const { member, dealer } = await memberForChange(actor, memberId, opts);
  if (member.status !== "ACTIVE") throw conflict("This person no longer has a team role.");
  const agents = member.teamRole === "TEAM_LEAD"
    ? await db.select().from(dealerSalespeople).where(and(eq(dealerSalespeople.parentId, memberId), eq(dealerSalespeople.status, "ACTIVE")))
    : [];
  const why = reasonOf(opts, "role removed: back to customer");
  await db.transaction(async (tx) => {
    await setSalespersonStatusIn(tx, dealer.id, memberId, "INACTIVE", { id: actor.id, role: actor.role });
    if (member.userId) {
      await recordRoleChange({ userId: member.userId, role: marketplaceRoleOf(member.teamRole), action: historyAction(opts, "REVOKED"), fromValue: member.teamRole === "TEAM_LEAD" ? "team_lead" : "agent", toValue: "customer", dealerId: dealer.id, salespersonId: memberId, actorUserId: actor.id, reason: why }, tx);
    }
    for (const a of agents) {
      if (!a.userId) continue;
      await recordRoleChange({ userId: a.userId, role: "agent", action: "REASSIGNED", fromValue: `agent under ${member.name}`, toValue: "agent under the dealer", dealerId: dealer.id, salespersonId: a.id, actorUserId: actor.id, reason: `team lead ${member.name} removed` }, tx);
    }
  });
  await tell(member, `Your team role with ${dealer.legalName} has ended; your account stays a customer account. Commission already earned is not affected.`);
}

/* ============================================================ My team view */

export interface TeamMemberRow {
  id: string;
  userId: string | null;
  name: string;
  employeeId: string;
  role: TeamRole;
  parentId: string | null;
  parentName: string | null;
  status: "ACTIVE" | "INACTIVE";
  code: string | null;
  mobileMasked: string | null;
  activeAgents: number;
  /** What still stops a payout (PAN, verified bank, agreement) — a "complete before first payout" card, not a blocker. */
  payoutMissing: string[];
  joinedIst: string;
}

export interface TeamInvitationRow {
  id: string;
  role: TeamRole;
  contact: string;
  parentName: string | null;
  status: string;
  registered: boolean;
  createdIst: string;
  expiresIst: string;
  byLead: boolean;
}

export interface TeamHistoryRow {
  id: string;
  person: string;
  role: string;
  action: string;
  fromValue: string | null;
  toValue: string | null;
  by: string;
  reason: string | null;
  atIst: string;
}

export interface TeamOverview {
  viewer: "DEALER" | "TEAM_LEAD";
  dealer: { id: string; name: string };
  leadId: string | null;
  canAddLeads: boolean;
  canAddAgents: boolean;
  inviteExpiryDays: number;
  members: TeamMemberRow[];
  leads: { id: string; name: string }[];
  invitations: TeamInvitationRow[];
  history: TeamHistoryRow[];
}

/** Everything the /dealer/team page shows. A team lead sees his own agents and the requests he sent. */
export async function teamOverview(actor: TeamActor): Promise<TeamOverview> {
  await requireOnboardingV2();
  const ctx = await teamContextFor(actor.id);
  const rule = await getRule("onboardingV2");
  await expireStale(eq(teamInvitations.dealerId, ctx.dealer.id));
  const [rows, views] = await Promise.all([
    db.select().from(dealerSalespeople).where(eq(dealerSalespeople.dealerId, ctx.dealer.id)).orderBy(dealerSalespeople.createdAt),
    listSalespeople(ctx.dealer.id),
  ]);
  const visible = rows.filter((r) => !ctx.lead || r.parentId === ctx.lead.id);
  const members: TeamMemberRow[] = [];
  for (const r of visible) {
    const view = views.find((v) => v.id === r.id);
    members.push({
      id: r.id,
      userId: r.userId,
      name: r.name,
      employeeId: r.employeeId,
      role: r.teamRole,
      parentId: r.parentId,
      parentName: r.parentId ? (rows.find((p) => p.id === r.parentId)?.name ?? null) : null,
      status: r.status,
      code: view?.code ?? null,
      mobileMasked: view?.mobileMasked ?? null,
      activeAgents: rows.filter((c) => c.parentId === r.id && c.status === "ACTIVE").length,
      payoutMissing: r.status === "ACTIVE" ? (await payeeStatus(db, ctx.dealer.id, r.id)).missing : [],
      joinedIst: formatIstStamp(r.createdAt),
    });
  }
  const invs = await db
    .select()
    .from(teamInvitations)
    .where(and(eq(teamInvitations.dealerId, ctx.dealer.id), ctx.lead ? eq(teamInvitations.invitedBySalespersonId, ctx.lead.id) : sql`true`))
    .orderBy(desc(teamInvitations.createdAt))
    .limit(100);
  const historyRows = ctx.lead
    ? []
    : await db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.dealerId, ctx.dealer.id)).orderBy(desc(onboardingRoleHistory.createdAt)).limit(200);
  const people = [...new Set(historyRows.flatMap((h) => [h.userId, h.actorUserId]).filter((v): v is string => Boolean(v)))];
  const names = people.length ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, people)) : [];
  const nameOf = (id: string | null) => {
    if (!id) return "GoKesari";
    const u = names.find((n) => n.id === id);
    return u?.name?.trim() || (u ? maskEmail(u.email) : "—");
  };
  return {
    viewer: ctx.lead ? "TEAM_LEAD" : "DEALER",
    dealer: { id: ctx.dealer.id, name: ctx.dealer.legalName },
    leadId: ctx.lead?.id ?? null,
    canAddLeads: !ctx.lead,
    canAddAgents: !ctx.lead || rule.teamLeadsCanAddAgents,
    inviteExpiryDays: rule.teamInviteExpiryDays,
    members,
    leads: rows.filter((r) => r.teamRole === "TEAM_LEAD" && r.status === "ACTIVE").map((r) => ({ id: r.id, name: r.name })),
    invitations: invs.map((i) => ({
      id: i.id,
      role: i.role,
      contact: i.inviteeEmail ? maskEmail(i.inviteeEmail) : i.inviteeMobileE164 ? maskPhone(i.inviteeMobileE164) : "—",
      parentName: i.parentSalespersonId ? (rows.find((p) => p.id === i.parentSalespersonId)?.name ?? null) : null,
      status: i.status,
      registered: Boolean(i.inviteeUserId),
      createdIst: formatIstStamp(i.createdAt),
      expiresIst: formatIstStamp(i.expiresAt),
      byLead: Boolean(i.invitedBySalespersonId),
    })),
    history: historyRows.map((h) => ({
      id: h.id,
      person: nameOf(h.userId),
      role: h.role,
      action: h.action,
      fromValue: h.fromValue,
      toValue: h.toValue,
      by: nameOf(h.actorUserId),
      reason: h.reason,
      atIst: formatIstStamp(h.createdAt),
    })),
  };
}

/** The signed-in member's own "complete before first payout" card (null when nothing is missing or no team role). */
export async function myPayoutReadiness(userId: string): Promise<{ missing: string[]; dealerName: string } | null> {
  const mine = await getMemberForUser(userId);
  if (!mine) return null;
  const { missing } = await payeeStatus(db, mine.dealer.id, mine.member.id);
  return missing.length ? { missing, dealerName: mine.dealer.legalName } : null;
}

/* ================================================================== admin */

export type AdminTeamOverride = "TEAM_LEAD" | "AGENT" | "REMOVE";

/**
 * ADMIN: override one account's team role (Admin → user page). Recorded as OVERRIDE in the role history with the
 * admin's reason; the same rules hold (a lead with active agents cannot become an agent).
 */
export async function adminOverrideTeamRole(actor: TeamActor, userId: string, input: { to: AdminTeamOverride; parentId?: string | null; reason: string }): Promise<void> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can override a team role.");
  await requireOnboardingV2();
  const member = await activeMemberOf(userId);
  if (!member) throw conflict("This account has no active team role.");
  const opts: ChangeOptions = { override: true, reason: input.reason };
  const [row] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, member.id));
  if (input.to === "REMOVE") return removeTeamRole(actor, member.id, opts);
  if (input.to === "TEAM_LEAD") {
    if (row.teamRole === "TEAM_LEAD") throw conflict("This person is already a team lead.");
    await upgradeToTeamLead(actor, member.id, opts);
    return;
  }
  if (row.teamRole === "TEAM_LEAD") await downgradeToAgent(actor, member.id, { parentId: input.parentId ?? null }, opts);
  else await reassignAgent(actor, member.id, { parentId: input.parentId ?? null }, opts);
}

/** ADMIN: an account's marketplace roles, team place and role history (IST) for the user page. */
export async function adminMarketplaceRoleView(userId: string) {
  const [view, history, member] = await Promise.all([
    listMarketplaceRoles(userId),
    db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.userId, userId)).orderBy(desc(onboardingRoleHistory.createdAt)).limit(100),
    db
      .select({ m: dealerSalespeople, dealerName: dealers.legalName })
      .from(dealerSalespeople)
      .innerJoin(dealers, eq(dealers.id, dealerSalespeople.dealerId))
      .where(and(eq(dealerSalespeople.userId, userId), eq(dealerSalespeople.status, "ACTIVE")))
      .limit(1),
  ]);
  const team = member[0] ?? null;
  const leads = team
    ? await db
        .select({ id: dealerSalespeople.id, name: dealerSalespeople.name })
        .from(dealerSalespeople)
        .where(and(eq(dealerSalespeople.dealerId, team.m.dealerId), eq(dealerSalespeople.teamRole, "TEAM_LEAD"), eq(dealerSalespeople.status, "ACTIVE"), ne(dealerSalespeople.id, team.m.id)))
    : [];
  const actors = [...new Set(history.map((h) => h.actorUserId).filter((v): v is string => Boolean(v)))];
  const names = actors.length ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, actors)) : [];
  return {
    roles: view.roles,
    team: team
      ? { memberId: team.m.id, dealerName: team.dealerName, role: team.m.teamRole, parentName: team.m.parentId ? await leadName(db, team.m.parentId) : "the dealer", activeAgents: (await db.select({ n: sql<number>`count(*)::int` }).from(dealerSalespeople).where(and(eq(dealerSalespeople.parentId, team.m.id), eq(dealerSalespeople.status, "ACTIVE"))))[0].n }
      : null,
    leads,
    history: history.map((h) => {
      const by = names.find((n) => n.id === h.actorUserId);
      return { id: h.id, role: h.role, action: h.action, fromValue: h.fromValue, toValue: h.toValue, reason: h.reason, by: by ? by.name?.trim() || maskEmail(by.email) : h.actorUserId ? "—" : "GoKesari", atIst: formatIstStamp(h.createdAt) };
    }),
  };
}
