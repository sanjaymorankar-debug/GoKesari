/**
 * RBAC v2 Phase 6 — who may do what in Operations (docs/rbac/06-operations.md).
 *
 * Every service function starts here, so the backend enforces the rules whatever the screen shows:
 *   1. the flag rbac_v2_operations must be on for the actor's role (off → "not available");
 *   2. the actor's role must hold the capability (refusals are audit-logged as authz.denied).
 *
 *   manage  OPS_TEAM_MANAGE    Operations Manager (and Admin): assign tasks and zones, see the team
 *   work    OPS_TASK_WORK_OWN  Operations User: own tasks, own customer assists
 *   report  OPS_REPORT_VIEW    Operations Manager (and Admin): onboarding reports and exports
 *   assist  CUSTOMER_ONBOARD_ASSIST  Operations User: help a customer register
 */
import { forbidden } from "@/lib/errors";
import { logDenied } from "@/server/authz/guards";
import { can, PERMISSIONS, type Permission } from "@/server/authz/permissions";
import type { UserRole } from "@/server/db/schema";
import { requireFeatureForRole } from "@/server/services/feature-flags";

export interface OpsActor {
  id: string;
  role: UserRole;
  name?: string | null;
}

export type OpsNeed = "manage" | "work" | "report" | "assist";

const NEEDS: Record<OpsNeed, Permission> = {
  manage: PERMISSIONS.OPS_TEAM_MANAGE,
  work: PERMISSIONS.OPS_TASK_WORK_OWN,
  report: PERMISSIONS.OPS_REPORT_VIEW,
  assist: PERMISSIONS.CUSTOMER_ONBOARD_ASSIST,
};

export const OPS_FLAG = "rbac_v2_operations" as const;

/** Throws unless the flag is on for the role and the role holds at least one of the needs. */
export async function requireOps(actor: OpsActor, ...needs: OpsNeed[]): Promise<void> {
  await requireFeatureForRole(OPS_FLAG, actor.role);
  if (!needs.some((n) => can(actor.role, NEEDS[n]))) {
    logDenied(actor, needs.map((n) => NEEDS[n]).join("|"), "permission");
    throw forbidden("You do not have permission to perform this action.");
  }
}

/** A manager sees and changes the whole Operations team's work; a user only their own. */
export function isOpsManager(actor: Pick<OpsActor, "role">): boolean {
  return can(actor.role, PERMISSIONS.OPS_TEAM_MANAGE);
}

/** Refuse (and log) an Operations User reaching for someone else's record. */
export function denyNotOwn(actor: OpsActor, what: string): never {
  logDenied(actor, `ops:${what}:own`, "permission");
  throw forbidden("This is assigned to someone else.");
}
