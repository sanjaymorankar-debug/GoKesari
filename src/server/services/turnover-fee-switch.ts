/**
 * The turnover fee slabs' On/Off switch (owner, 28-Nov-2026): "Remove turnover slab itself and create a button to
 * switch it on or off by admin / operator with four-eye principle for later enablement" — and "fee should be flat 999
 * as default fee".
 *
 * Rule registrationFeeByTurnover.enabled is off by default (every new shop pays the flat fee, ₹999 + GST). It changes
 * only through this switch, and ALWAYS with four eyes, whatever flag rbac_v2_four_eye_admin says:
 *
 *   1. an ADMIN or OPERATOR presses the button → a pending approval request (TURNOVER_FEE_SWITCH); nothing changes;
 *   2. a DIFFERENT admin or operator approves (or rejects, with a comment) — in Admin → Registration fees or
 *      POST /api/approvals/{id}/decide; nobody approves their own request (no single-admin bootstrap either);
 *   3. approval sets enabled through the settings service (setRule), so the change is audited (who, when, old/new).
 *
 * The slabs editor and the generic settings API keep `enabled` as it is (keepTurnoverEnabled), and a reset of the rule
 * that would flip it is refused (assertResetKeepsTurnoverEnabled). Shops already registered keep their fee.
 */
import { and, desc, eq } from "drizzle-orm";

import { conflict, forbidden, validationFailed } from "@/lib/errors";
import { RULES } from "@/server/config/rules";
import { db } from "@/server/db";
import { approvalRequests, users, type UserRole } from "@/server/db/schema";
import { getActiveFee } from "./registration-fees";
import { getRule, setRule } from "./settings";

export const TURNOVER_FEE_SWITCH = "TURNOVER_FEE_SWITCH" as const;
export const TURNOVER_RULE_KEY = "registrationFeeByTurnover" as const;
/** Who may ask for the switch, and who may approve it (a different person). */
export const TURNOVER_SWITCH_ROLES: readonly UserRole[] = ["ADMIN", "OPERATOR"];

interface Actor {
  id: string;
  role: UserRole;
  email?: string | null;
}

export interface TurnoverSwitchPending {
  approvalId: string;
  /** What the request asks for. */
  enabled: boolean;
  reason: string;
  requestedBy: string;
  requestedByName: string | null;
  requestedByRole: string;
  requestedAt: string;
}

export interface TurnoverSwitchState {
  enabled: boolean;
  /** The flat fee in force (before GST), used while the slabs are off; null when none is configured. */
  flatFeePaise: number | null;
  pending: TurnoverSwitchPending | null;
}

export function mayUseTurnoverSwitch(role: UserRole): boolean {
  return TURNOVER_SWITCH_ROLES.includes(role);
}

async function pendingRequest(): Promise<TurnoverSwitchPending | null> {
  const [row] = await db
    .select({ request: approvalRequests, name: users.name, email: users.email })
    .from(approvalRequests)
    .leftJoin(users, eq(users.id, approvalRequests.requestedBy))
    .where(and(eq(approvalRequests.type, TURNOVER_FEE_SWITCH), eq(approvalRequests.status, "PENDING")))
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(1);
  if (!row) return null;
  const r = row.request;
  return {
    approvalId: r.id,
    enabled: r.payload.enabled === true,
    reason: r.reason,
    requestedBy: r.requestedBy,
    requestedByName: row.name ?? row.email ?? null,
    requestedByRole: r.requestedByRole,
    requestedAt: r.requestedAt.toISOString(),
  };
}

export async function getTurnoverSwitchState(): Promise<TurnoverSwitchState> {
  const [rule, fee, pending] = await Promise.all([getRule(TURNOVER_RULE_KEY), getActiveFee(), pendingRequest()]);
  return { enabled: rule.enabled, flatFeePaise: fee?.amountPaise ?? null, pending };
}

/**
 * Step 1: asks for the slabs to be switched on or off. Nothing changes until a different admin or operator approves.
 * One request at a time.
 */
export async function requestTurnoverFeeSwitch(actor: Actor, input: { enabled: boolean; reason?: string | null }) {
  if (!mayUseTurnoverSwitch(actor.role)) throw forbidden("Only an admin or an operator can switch the turnover fee slabs.");
  const state = await getTurnoverSwitchState();
  if (state.pending) {
    throw conflict("A request to switch the turnover fee slabs is already waiting for approval. Approve, reject or cancel it first.", {
      approvalId: state.pending.approvalId,
    });
  }
  if (state.enabled === input.enabled) {
    throw validationFailed(`The turnover fee slabs are already ${input.enabled ? "on" : "off"}.`);
  }
  const what = input.enabled ? "On (fee by declared annual turnover)" : "Off (flat registration fee)";
  const reason = input.reason?.trim() || `Turnover fee slabs ${input.enabled ? "on" : "off"}`;
  // Lazy: @/server/approvals registers the handler (admin-actions.ts), which imports this module.
  const { submitApproval } = await import("@/server/approvals");
  const request = await submitApproval({
    type: TURNOVER_FEE_SWITCH,
    actor,
    subjectType: "rule",
    subjectId: TURNOVER_RULE_KEY,
    title: `Turnover fee slabs: ${what}`,
    reason,
    payload: { key: TURNOVER_RULE_KEY, enabled: input.enabled, previous: state.enabled },
  });
  return {
    pendingApproval: true as const,
    approvalId: request.id,
    message: "Sent for approval. A different admin or operator must approve it before it takes effect.",
  };
}

/** Step 3 (the approval's executor): sets enabled, keeping the slabs. Audited by setRule (who, when, old/new). */
export async function applyTurnoverFeeSwitch(enabled: boolean, actor: Actor): Promise<void> {
  const current = await getRule(TURNOVER_RULE_KEY);
  await setRule(TURNOVER_RULE_KEY, { ...current, enabled }, actor);
}

/**
 * The slabs editor, the generic settings API and a RULE_SET approval change the slabs only: `enabled` is always kept
 * as it is now (it changes only through the four-eye switch).
 */
export async function keepTurnoverEnabled(value: Record<string, unknown>): Promise<Record<string, unknown>> {
  const current = await getRule(TURNOVER_RULE_KEY);
  return { ...value, enabled: current.enabled };
}

/** A reset to the defaults must not flip the switch either. */
export async function assertResetKeepsTurnoverEnabled(): Promise<void> {
  const current = await getRule(TURNOVER_RULE_KEY);
  if (current.enabled !== RULES[TURNOVER_RULE_KEY].defaults.enabled) {
    throw validationFailed(
      "Resetting this setting would switch the turnover fee slabs " +
        (current.enabled ? "off" : "on") +
        ". Use the Turnover slabs button in Admin → Registration fees (a second admin or operator approves it), then reset.",
    );
  }
}
