/**
 * Onboarding v2 marketplace roles (docs/onboarding-v2-2026-11).
 *
 * One account holds several roles: customer, shop_owner, dealer_free, franchisee_paid, team_lead, agent (+ the
 * existing admin / operator). They are DERIVED from the tables that already decide them, so nothing is stored twice
 * and the commission engine keeps reading what it always read:
 *   - customer      every account (CUSTOMER is implicit, services/roles.ts)
 *   - shop_owner    user_role_grants SHOP_OWNER (granted by shop registration)
 *   - dealer_free   an APPROVED dealer with no active / suspended / expired paid franchise allocation
 *   - franchisee_paid an APPROVED dealer that holds a paid franchise allocation
 *   - team_lead / agent  an ACTIVE dealer_salespeople row linked to the account (team_role)
 *   - admin / operator   user_role_grants (OPERATOR / OPERATOR_LIMITED / OPERATIONS_* map to operator)
 * Every change made through onboarding v2 is written to onboarding_role_history (who, what, when — UTC stored,
 * shown in IST).
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import {
  dealerSalespeople,
  dealers,
  franchiseAllocations,
  onboardingRoleHistory,
  userRoleGrants,
  type MarketplaceRole,
  type RoleHistoryAction,
} from "@/server/db/schema";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const ONBOARDING_V2_FLAG = "onboarding_v2" as const;

/** True when the onboarding_v2 flag is on (missing row / read error = off). */
export async function onboardingV2Enabled(): Promise<boolean> {
  return isFeatureEnabled(ONBOARDING_V2_FLAG).catch(() => false);
}

const OPERATOR_GRANTS = new Set(["OPERATOR", "OPERATOR_LIMITED", "OPERATIONS_MANAGER", "OPERATIONS_USER"]);
const PAID_ALLOCATION_STATUSES = ["ACTIVE", "SUSPENDED", "EXPIRED"] as const;

export interface MarketplaceRoleView {
  roles: MarketplaceRole[];
  dealerId: string | null;
  /** dealer_salespeople.id when the account is a team lead or agent. */
  salespersonId: string | null;
  salespersonDealerId: string | null;
}

/** All marketplace roles of one account, customer first. */
export async function listMarketplaceRoles(userId: string, client: DbClient = db): Promise<MarketplaceRoleView> {
  const roles = new Set<MarketplaceRole>(["customer"]);
  const grants = await client
    .select({ role: userRoleGrants.role })
    .from(userRoleGrants)
    .where(and(eq(userRoleGrants.userId, userId), eq(userRoleGrants.status, "ACTIVE")));
  for (const g of grants) {
    if (g.role === "SHOP_OWNER") roles.add("shop_owner");
    if (g.role === "ADMIN") roles.add("admin");
    if (OPERATOR_GRANTS.has(g.role)) roles.add("operator");
  }

  const [dealer] = await client
    .select({ id: dealers.id, status: dealers.status })
    .from(dealers)
    .where(eq(dealers.userId, userId))
    .orderBy(desc(dealers.createdAt))
    .limit(1);
  let dealerId: string | null = null;
  if (dealer && dealer.status === "APPROVED") {
    dealerId = dealer.id;
    const [paid] = await client
      .select({ id: franchiseAllocations.id })
      .from(franchiseAllocations)
      .where(and(eq(franchiseAllocations.ownerDealerId, dealer.id), inArray(franchiseAllocations.status, [...PAID_ALLOCATION_STATUSES])))
      .limit(1);
    roles.add(paid ? "franchisee_paid" : "dealer_free");
  }

  const [member] = await client
    .select({ id: dealerSalespeople.id, dealerId: dealerSalespeople.dealerId, teamRole: dealerSalespeople.teamRole })
    .from(dealerSalespeople)
    .where(and(eq(dealerSalespeople.userId, userId), eq(dealerSalespeople.status, "ACTIVE")))
    .limit(1);
  if (member) roles.add(member.teamRole === "TEAM_LEAD" ? "team_lead" : "agent");

  return {
    roles: [...roles],
    dealerId,
    salespersonId: member?.id ?? null,
    salespersonDealerId: member?.dealerId ?? null,
  };
}

export interface RoleChange {
  userId: string;
  role: MarketplaceRole;
  action: RoleHistoryAction;
  fromValue?: string | null;
  toValue?: string | null;
  dealerId?: string | null;
  salespersonId?: string | null;
  actorUserId?: string | null;
  reason?: string | null;
}

/** Appends one row to the role history (call inside the same transaction as the change). */
export async function recordRoleChange(change: RoleChange, client: DbClient = db): Promise<void> {
  await client.insert(onboardingRoleHistory).values({
    userId: change.userId,
    role: change.role,
    action: change.action,
    fromValue: change.fromValue ?? null,
    toValue: change.toValue ?? null,
    dealerId: change.dealerId ?? null,
    salespersonId: change.salespersonId ?? null,
    actorUserId: change.actorUserId ?? null,
    reason: change.reason ?? null,
  });
}

/** Role history of one account, newest first (admin panel, member page). */
export async function roleHistoryForUser(userId: string, limit = 100) {
  return db
    .select()
    .from(onboardingRoleHistory)
    .where(eq(onboardingRoleHistory.userId, userId))
    .orderBy(desc(onboardingRoleHistory.createdAt))
    .limit(limit);
}

/** Role history of a dealer's team, newest first ("My team" audit trail). */
export async function roleHistoryForDealer(dealerId: string, limit = 200) {
  return db
    .select()
    .from(onboardingRoleHistory)
    .where(eq(onboardingRoleHistory.dealerId, dealerId))
    .orderBy(desc(onboardingRoleHistory.createdAt))
    .limit(limit);
}

/** "26 Nov 2026, 06.19 PM IST" — every v2 screen and report shows IST. */
export function formatIstStamp(at: Date | string | null | undefined): string {
  if (!at) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}.${get("minute")} ${get("dayPeriod").toUpperCase()} IST`;
}
