/**
 * RBAC v2 Phase 3 — financial rate changes (brief §3.3; docs/rbac/03-phase3-accounting.md).
 *
 *   Accountant (RATE_PROPOSE) proposes → CA (RATE_APPROVE) approves → Admin (RATE_ACTIVATE) activates
 *
 * Activation calls the EXISTING setter for the rate, acting as the activating admin, so the rate logic is
 * unchanged (stop gate 4 respected): setCommissionRate, setRegistrationFee (which schedules a future
 * date itself), setRule("shopWallet") for the delivery charge. A commission or delivery charge whose
 * effective time is still ahead is SCHEDULED and activated by the hourly rbac-v2 sweep. Rates are untouched
 * until activation. The existing direct admin edits remain (an additive path, not a replacement).
 */
import { and, desc, eq, lte } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { MAX_REGISTRATION_FEE_PAISE } from "@/lib/money-limits";
import { db } from "@/server/db";
import { commissionRates, rateChangeProposals, type RateChangeProposal, type RateKind, type UserRole } from "@/server/db/schema";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { requireFeatureForRole } from "@/server/services/feature-flags";
import { setCommissionRate } from "@/server/services/finance";
import { getActiveFee, setRegistrationFee } from "@/server/services/registration-fees";
import { getRule, setRule } from "@/server/services/settings";
import { cancelApproval, registerApprovalHandler, submitApproval, type ApprovalActor } from "@/server/approvals/engine";

export const RATE_APPROVAL = "RATE_CHANGE";

interface Actor {
  id: string;
  role: UserRole;
}

export interface RateProposalInput {
  rateKind: RateKind;
  /** COMMISSION only. */
  scope?: "DEFAULT" | "SHOP_TYPE" | "SHOP";
  shopType?: string | null;
  shopId?: string | null;
  /** COMMISSION: basis points (500 = 5%). */
  rateBp?: number;
  /** REGISTRATION_FEE / DELIVERY_CHARGE: paise. */
  amountPaise?: number;
  effectiveAt: Date;
  reason: string;
}

const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

async function currentValue(input: RateProposalInput): Promise<unknown> {
  if (input.rateKind === "REGISTRATION_FEE") return { amountPaise: (await getActiveFee())?.amountPaise ?? null };
  if (input.rateKind === "DELIVERY_CHARGE") return { deliveryChargePaise: (await getRule("shopWallet")).deliveryChargePaise };
  const target =
    input.scope === "SHOP_TYPE"
      ? and(eq(commissionRates.scope, "SHOP_TYPE"), eq(commissionRates.shopType, input.shopType ?? ""))
      : input.scope === "SHOP"
        ? and(eq(commissionRates.scope, "SHOP"), eq(commissionRates.shopId, input.shopId ?? ""))
        : eq(commissionRates.scope, "DEFAULT");
  const [row] = await db.select({ rateBp: commissionRates.rateBp }).from(commissionRates).where(and(target, eq(commissionRates.isActive, true)));
  return { rateBp: row?.rateBp ?? null };
}

function describe(p: Pick<RateChangeProposal, "rateKind" | "scope" | "scopeKey" | "proposedValue">): string {
  const v = p.proposedValue;
  if (p.rateKind === "COMMISSION") return `Commission ${p.scope}${p.scopeKey ? ` ${p.scopeKey}` : ""} → ${(Number(v.rateBp) / 100).toFixed(2)}%`;
  if (p.rateKind === "REGISTRATION_FEE") return `Registration fee → ₹${(Number(v.amountPaise) / 100).toFixed(2)}`;
  return `Delivery charge → ₹${(Number(v.amountPaise) / 100).toFixed(2)} per delivery`;
}

export async function proposeRateChange(input: RateProposalInput, actor: Actor): Promise<RateChangeProposal> {
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  if (!can(actor.role, PERMISSIONS.RATE_PROPOSE)) throw forbidden("Only an Accountant proposes rate changes.");
  const reason = input.reason.trim();
  if (reason.length < 5) throw validationFailed("Say why the rate should change.", { fields: { reason: "At least 5 characters." } });
  if (Number.isNaN(input.effectiveAt.getTime())) throw validationFailed("Give the effective date and time.");

  let proposedValue: Record<string, unknown>;
  let scope: string | null = null;
  let scopeKey: string | null = null;
  if (input.rateKind === "COMMISSION") {
    if (!Number.isInteger(input.rateBp) || input.rateBp! < 0 || input.rateBp! > 5000) throw validationFailed("Commission must be 0–50% (0–5000 basis points).");
    scope = input.scope ?? "DEFAULT";
    if (scope === "SHOP_TYPE" && !input.shopType) throw validationFailed("Choose the shop type.");
    if (scope === "SHOP" && !input.shopId) throw validationFailed("Choose the shop.");
    scopeKey = scope === "SHOP_TYPE" ? input.shopType! : scope === "SHOP" ? input.shopId! : null;
    proposedValue = { rateBp: input.rateBp };
  } else {
    const max = input.rateKind === "REGISTRATION_FEE" ? MAX_REGISTRATION_FEE_PAISE : 1_000_000;
    if (!Number.isInteger(input.amountPaise) || input.amountPaise! < 0 || input.amountPaise! > max) {
      throw validationFailed(`The amount must be whole paise from 0 to ${max}.`);
    }
    proposedValue = { amountPaise: input.amountPaise };
  }

  const [proposal] = await db
    .insert(rateChangeProposals)
    .values({
      rateKind: input.rateKind,
      scope,
      scopeKey,
      currentValue: (await currentValue(input)) as never,
      proposedValue,
      effectiveAt: input.effectiveAt,
      reason,
      proposedBy: actor.id,
    })
    .returning();
  const request = await submitApproval({
    type: RATE_APPROVAL,
    actor,
    subjectType: "rate_change_proposal",
    subjectId: proposal.id,
    title: `${describe(proposal)} from ${istDate(input.effectiveAt)}`,
    reason,
    payload: { proposalId: proposal.id },
    effectiveAt: input.effectiveAt,
    items: [{ entityType: "rate", entityId: scopeKey, field: input.rateKind, previousValue: proposal.currentValue, proposedValue }],
  });
  const [linked] = await db.update(rateChangeProposals).set({ approvalRequestId: request.id }).where(eq(rateChangeProposals.id, proposal.id)).returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.RATE_PROPOSED, entityType: "rate_change_proposal", entityId: proposal.id, previousValue: proposal.currentValue, newValue: { ...proposedValue, effectiveAt: input.effectiveAt.toISOString(), reason } });
  return linked;
}

export async function cancelRateProposal(proposalId: string, actor: Actor): Promise<RateChangeProposal> {
  const [p] = await db.select().from(rateChangeProposals).where(eq(rateChangeProposals.id, proposalId));
  if (!p) throw notFound("Rate proposal");
  if (!p.approvalRequestId) throw conflict("This proposal has no open request.");
  await cancelApproval(p.approvalRequestId, actor);
  const [row] = await db.update(rateChangeProposals).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(rateChangeProposals.id, proposalId)).returning();
  return row;
}

/** Calls the existing setter. Registration fees schedule a future date themselves. */
async function activate(p: RateChangeProposal, actor: Actor): Promise<void> {
  const v = p.proposedValue;
  if (p.rateKind === "COMMISSION") {
    await setCommissionRate(
      {
        scope: (p.scope ?? "DEFAULT") as "DEFAULT" | "SHOP_TYPE" | "SHOP",
        shopType: p.scope === "SHOP_TYPE" ? (p.scopeKey as never) : null,
        shopId: p.scope === "SHOP" ? p.scopeKey : null,
        rateBp: Number(v.rateBp),
        note: `Rate proposal ${p.id}: ${p.reason}`.slice(0, 300),
      },
      actor,
    );
  } else if (p.rateKind === "REGISTRATION_FEE") {
    await setRegistrationFee({ amountPaise: Number(v.amountPaise), effectiveFrom: istDate(p.effectiveAt), reason: p.reason, note: `Rate proposal ${p.id}` }, actor);
  } else {
    const current = await getRule("shopWallet");
    await setRule("shopWallet", { ...current, deliveryChargePaise: Number(v.amountPaise) }, actor);
  }
}

async function activateOrSchedule(proposalId: string, admin: ApprovalActor): Promise<void> {
  const [p] = await db.select().from(rateChangeProposals).where(eq(rateChangeProposals.id, proposalId));
  if (!p) throw notFound("Rate proposal");
  const due = p.effectiveAt.getTime() <= Date.now() || p.rateKind === "REGISTRATION_FEE";
  if (!due) {
    await db.update(rateChangeProposals).set({ status: "SCHEDULED", updatedAt: new Date() }).where(eq(rateChangeProposals.id, p.id));
    return;
  }
  await activate(p, admin);
  await db.update(rateChangeProposals).set({ status: "ACTIVATED", activatedAt: new Date(), updatedAt: new Date() }).where(eq(rateChangeProposals.id, p.id));
  await recordAudit({ actorId: admin.id, actorRole: admin.role, action: AUDIT_ACTIONS.RATE_ACTIVATED, entityType: "rate_change_proposal", entityId: p.id, previousValue: p.currentValue, newValue: p.proposedValue });
}

registerApprovalHandler({
  type: RATE_APPROVAL,
  checker: "CA_THEN_ADMIN",
  async apply(context) {
    await activateOrSchedule(String(context.request.payload.proposalId), context.decidedBy);
  },
  async onAdvanced(request) {
    await db.update(rateChangeProposals).set({ status: "PENDING_ADMIN", updatedAt: new Date() }).where(eq(rateChangeProposals.id, String(request.payload.proposalId)));
  },
  async onRejected(request) {
    await db.update(rateChangeProposals).set({ status: "REJECTED", updatedAt: new Date() }).where(eq(rateChangeProposals.id, String(request.payload.proposalId)));
  },
});

/** Hourly: SCHEDULED proposals whose time has come, activated as the admin who approved them. */
export async function activateDueRateProposals(): Promise<{ activated: number; failed: number }> {
  const due = await db
    .select()
    .from(rateChangeProposals)
    .where(and(eq(rateChangeProposals.status, "SCHEDULED"), lte(rateChangeProposals.effectiveAt, new Date())));
  let activated = 0;
  let failed = 0;
  for (const p of due) {
    const { approvalRequests } = await import("@/server/db/schema");
    const [req] = p.approvalRequestId ? await db.select().from(approvalRequests).where(eq(approvalRequests.id, p.approvalRequestId)) : [];
    const admin = { id: req?.decidedBy ?? p.proposedBy, role: "ADMIN" as const };
    try {
      await activate(p, admin);
      await db.update(rateChangeProposals).set({ status: "ACTIVATED", activatedAt: new Date(), updatedAt: new Date() }).where(eq(rateChangeProposals.id, p.id));
      await recordAudit({ actorId: admin.id, actorRole: "ADMIN", action: AUDIT_ACTIONS.RATE_ACTIVATED, entityType: "rate_change_proposal", entityId: p.id, previousValue: p.currentValue, newValue: p.proposedValue });
      activated += 1;
    } catch (error) {
      failed += 1;
      await db
        .update(rateChangeProposals)
        .set({ status: "FAILED", applyError: (error instanceof Error ? error.message : String(error)).slice(0, 1000), updatedAt: new Date() })
        .where(eq(rateChangeProposals.id, p.id));
    }
  }
  return { activated, failed };
}

export async function listRateProposals(limit = 100): Promise<RateChangeProposal[]> {
  return db.select().from(rateChangeProposals).orderBy(desc(rateChangeProposals.createdAt)).limit(limit);
}
