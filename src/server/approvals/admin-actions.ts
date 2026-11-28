/**
 * RBAC v2 four-eye admin actions (brief §3.1, §10; docs/rbac/01-assessment.md G1).
 *
 * Behind flag rbac_v2_four_eye_admin (seeded OFF). Off: every route applies the change at once, as
 * before. On: the route records an approval request instead, and the change is applied — by the
 * same existing service function, acting as the requesting admin — only when a different admin
 * approves (or the Super Admin alone while fewer than two admins are active).
 *
 * Emergency suspension (brief §3.1) is the exception: it applies at once and opens a
 * USER_SUSPEND_CONFIRM request that a second admin must confirm within 24 hours. Rejecting it lifts
 * the suspension; an unconfirmed one is listed as overdue on the Admin board.
 */
import { AppError, validationFailed } from "@/lib/errors";
import { FEATURE_FLAG_KEYS, type FeatureFlagKey, type UserRole } from "@/server/db/schema";
import { isFeatureEnabled, setFeatureFlag, setFeatureFlagRoleScope } from "@/server/services/feature-flags";
import { revokeRole } from "@/server/services/roles";
import { resetRule, setRule } from "@/server/services/settings";
import { setCommissionRate } from "@/server/services/finance";
import { setRegistrationFee } from "@/server/services/registration-fees";
import {
  applyTurnoverFeeSwitch,
  assertResetKeepsTurnoverEnabled,
  keepTurnoverEnabled,
  TURNOVER_FEE_SWITCH,
  TURNOVER_RULE_KEY,
  TURNOVER_SWITCH_ROLES,
} from "@/server/services/turnover-fee-switch";
import type { RuleKey } from "@/server/config/rules";
import { reinstateUser, setUserRole, suspendUser, updateUserPrivileges } from "@/server/services/users";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { registerApprovalHandler, submitApproval, type ApprovalActor, type ApplyContext } from "./engine";

export const FOUR_EYE_TYPES = {
  USER_PRIVILEGES_SET: "USER_PRIVILEGES_SET",
  USER_ROLE_SET: "USER_ROLE_SET",
  USER_ROLE_REVOKE: "USER_ROLE_REVOKE",
  USER_REACTIVATE: "USER_REACTIVATE",
  USER_SUSPEND_CONFIRM: "USER_SUSPEND_CONFIRM",
  FEATURE_FLAG_SET: "FEATURE_FLAG_SET",
  FEATURE_FLAG_ROLE_SCOPE_SET: "FEATURE_FLAG_ROLE_SCOPE_SET",
  // Sensitive configuration (brief §3.1): business rules (thresholds), commission rates, registration fee.
  RULE_SET: "RULE_SET",
  RULE_RESET: "RULE_RESET",
  COMMISSION_RATE_SET: "COMMISSION_RATE_SET",
  REGISTRATION_FEE_SET: "REGISTRATION_FEE_SET",
  // Owner, 28-Nov-2026: the turnover fee slabs' On/Off button — always four-eye, admin or operator (turnover-fee-switch.ts).
  TURNOVER_FEE_SWITCH,
} as const;

/** Emergency suspensions must be confirmed by a second admin within this many hours. */
export const EMERGENCY_CONFIRM_HOURS = 24;

const requester = (context: ApplyContext): { id: string; role: UserRole } => ({
  id: context.request.requestedBy,
  role: context.request.requestedByRole as UserRole,
});
const str = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !value) throw new AppError("INTERNAL", `Approval payload is missing ${what}.`);
  return value;
};

registerApprovalHandler({
  type: FOUR_EYE_TYPES.USER_PRIVILEGES_SET,
  checker: "ADMIN",
  async apply(context) {
    const p = context.request.payload;
    await updateUserPrivileges(
      str(p.userId, "userId"),
      { activeRole: str(p.activeRole, "activeRole") as UserRole, heldRoles: (p.heldRoles as UserRole[]) ?? [] },
      requester(context),
    );
  },
});

registerApprovalHandler({
  type: FOUR_EYE_TYPES.USER_ROLE_SET,
  checker: "ADMIN",
  async apply(context) {
    const p = context.request.payload;
    await setUserRole(str(p.userId, "userId"), str(p.role, "role") as UserRole, requester(context));
  },
});

registerApprovalHandler({
  type: FOUR_EYE_TYPES.USER_ROLE_REVOKE,
  checker: "ADMIN",
  async apply(context) {
    const p = context.request.payload;
    await revokeRole(str(p.userId, "userId"), str(p.role, "role") as UserRole, requester(context));
  },
});

registerApprovalHandler({
  type: FOUR_EYE_TYPES.USER_REACTIVATE,
  checker: "ADMIN",
  async apply(context) {
    const p = context.request.payload;
    await reinstateUser(str(p.userId, "userId"), context.request.reason, requester(context));
  },
});

registerApprovalHandler({
  type: FOUR_EYE_TYPES.USER_SUSPEND_CONFIRM,
  checker: "ADMIN",
  // The suspension already applied; approving confirms it.
  async apply() {},
  async onRejected(request, decidedBy) {
    const userId = str(request.payload.userId, "userId");
    await reinstateUser(userId, `Emergency suspension not confirmed by a second admin: ${request.decisionComment ?? ""}`.trim(), {
      id: decidedBy.id,
      role: decidedBy.role,
    });
  },
});

registerApprovalHandler({
  type: FOUR_EYE_TYPES.FEATURE_FLAG_SET,
  checker: "ADMIN",
  async apply(context) {
    const p = context.request.payload;
    await setFeatureFlag(
      str(p.key, "key") as FeatureFlagKey,
      { enabled: Boolean(p.enabled), districtCodes: (p.districtCodes as string[] | null) ?? null },
      `${context.request.reason} (approved by a second admin)`,
      requester(context),
    );
  },
});

registerApprovalHandler({
  type: FOUR_EYE_TYPES.FEATURE_FLAG_ROLE_SCOPE_SET,
  checker: "ADMIN",
  async apply(context) {
    const p = context.request.payload;
    await setFeatureFlagRoleScope(
      str(p.key, "key") as FeatureFlagKey,
      (p.roleScope as UserRole[] | null) ?? null,
      `${context.request.reason} (approved by a second admin)`,
      requester(context),
    );
  },
});

registerApprovalHandler({
  type: FOUR_EYE_TYPES.RULE_SET,
  checker: "ADMIN",
  async apply(context) {
    const p = context.request.payload;
    const key = str(p.key, "key") as RuleKey;
    // The turnover slabs' enabled is switched only by TURNOVER_FEE_SWITCH: a slab change keeps it as it is now.
    const value = key === TURNOVER_RULE_KEY ? await keepTurnoverEnabled((p.value as Record<string, unknown>) ?? {}) : p.value;
    await setRule(key, value, requester(context));
  },
});

registerApprovalHandler({
  type: FOUR_EYE_TYPES.RULE_RESET,
  checker: "ADMIN",
  async apply(context) {
    const key = str(context.request.payload.key, "key") as RuleKey;
    if (key === TURNOVER_RULE_KEY) await assertResetKeepsTurnoverEnabled();
    await resetRule(key, requester(context));
  },
});

registerApprovalHandler({
  type: FOUR_EYE_TYPES.COMMISSION_RATE_SET,
  checker: "ADMIN",
  async apply(context) {
    const p = context.request.payload as unknown as Parameters<typeof setCommissionRate>[0];
    await setCommissionRate(p, requester(context));
  },
});

registerApprovalHandler({
  type: FOUR_EYE_TYPES.REGISTRATION_FEE_SET,
  checker: "ADMIN",
  async apply(context) {
    const p = context.request.payload as unknown as Parameters<typeof setRegistrationFee>[0];
    await setRegistrationFee(p, requester(context));
  },
});

registerApprovalHandler({
  type: FOUR_EYE_TYPES.TURNOVER_FEE_SWITCH,
  checker: "ADMIN",
  // Owner, 28-Nov-2026: an admin or an operator asks, a different admin or operator approves; never the requester.
  deciderRoles: TURNOVER_SWITCH_ROLES,
  strictFourEye: true,
  async apply(context) {
    const p = context.request.payload;
    if (typeof p.enabled !== "boolean") throw new AppError("INTERNAL", "Approval payload is missing enabled.");
    await applyTurnoverFeeSwitch(p.enabled, requester(context));
  },
});

/* ---------------------------------------------------------------- routing */

export async function fourEyeAdminOn(): Promise<boolean> {
  return isFeatureEnabled("rbac_v2_four_eye_admin");
}

/** What a route answers when the change waits for a second admin (HTTP 202). */
export interface PendingApprovalResponse {
  pendingApproval: true;
  approvalId: string;
  message: string;
}

const PENDING_MESSAGE = "Sent for approval. A different admin must approve this before it takes effect (Admin → Approvals).";

export async function requestFourEye(
  type: (typeof FOUR_EYE_TYPES)[keyof typeof FOUR_EYE_TYPES],
  actor: ApprovalActor,
  input: { subjectType: string; subjectId: string; title: string; reason: string; payload: Record<string, unknown> },
): Promise<PendingApprovalResponse> {
  const request = await submitApproval({
    type,
    actor,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    title: input.title,
    reason: input.reason,
    payload: input.payload,
  });
  return { pendingApproval: true, approvalId: request.id, message: PENDING_MESSAGE };
}

/**
 * Emergency suspension: applied at once (security), then a USER_SUSPEND_CONFIRM request is opened
 * that a second admin must confirm within EMERGENCY_CONFIRM_HOURS.
 */
export async function emergencySuspend(userId: string, reason: string, actor: ApprovalActor) {
  const result = await suspendUser(userId, reason, actor);
  const confirmBy = new Date(Date.now() + EMERGENCY_CONFIRM_HOURS * 3_600_000);
  const request = await submitApproval({
    type: FOUR_EYE_TYPES.USER_SUSPEND_CONFIRM,
    actor,
    subjectType: "user",
    subjectId: userId,
    title: "Confirm emergency suspension",
    reason,
    payload: { userId },
    confirmBy,
  });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.USER_EMERGENCY_SUSPENDED,
    entityType: "user",
    entityId: userId,
    newValue: { reason, approvalId: request.id, confirmBy: confirmBy.toISOString() },
  });
  return { ...result, approvalId: request.id, confirmBy };
}

export function assertFlagKey(key: string): FeatureFlagKey {
  if (!(FEATURE_FLAG_KEYS as readonly string[]).includes(key)) throw validationFailed("Unknown feature flag.");
  return key as FeatureFlagKey;
}
