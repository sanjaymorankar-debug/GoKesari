/**
 * Dealership & Franchise Platform phase 6 (docs/dealer-platform/): maker-checker for the dealer platform's sensitive
 * commercial and financial changes, behind flag dealer_platform_four_eye (seeded OFF).
 *
 *   DEALER_SCHEME_PUBLISH   publish or schedule a scheme version
 *   DEALER_SCHEME_STATUS    suspend / reopen / expire / archive a scheme
 *   DEALER_SCHEME_CHANGE    move a dealer to another scheme version (he has accepted it)
 *   FRANCHISE_REFUND        refund a franchise booking
 * Off: the routes apply at once, as before. On: the route records a request; a different admin approves in Admin →
 * Approvals and the change is applied then, by the same service, acting as the requester.
 */
import { AppError } from "@/lib/errors";
import type { UserRole } from "@/server/db/schema";
import { isFeatureEnabled } from "@/server/services/feature-flags";

import { registerApprovalHandler, submitApproval, type ApplyContext, type ApprovalActor } from "./engine";

export const DEALER_FOUR_EYE_TYPES = {
  DEALER_SCHEME_PUBLISH: "DEALER_SCHEME_PUBLISH",
  DEALER_SCHEME_STATUS: "DEALER_SCHEME_STATUS",
  DEALER_SCHEME_CHANGE: "DEALER_SCHEME_CHANGE",
  FRANCHISE_REFUND: "FRANCHISE_REFUND",
} as const;

export async function dealerFourEyeOn(): Promise<boolean> {
  return isFeatureEnabled("dealer_platform_four_eye");
}

const requester = (c: ApplyContext): { id: string; role: UserRole } => ({ id: c.request.requestedBy, role: c.request.requestedByRole as UserRole });
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new AppError("INTERNAL", `Approval payload is missing ${what}.`);
  return v;
};

registerApprovalHandler({
  type: DEALER_FOUR_EYE_TYPES.DEALER_SCHEME_PUBLISH,
  checker: "ADMIN",
  async apply(c) {
    const p = c.request.payload;
    const { publishVersion } = await import("@/server/dealers/scheme-admin");
    await publishVersion(requester(c), str(p.versionId, "versionId"), { effectiveFrom: typeof p.effectiveFrom === "string" ? new Date(p.effectiveFrom) : null, reason: c.request.reason });
  },
});

registerApprovalHandler({
  type: DEALER_FOUR_EYE_TYPES.DEALER_SCHEME_STATUS,
  checker: "ADMIN",
  async apply(c) {
    const p = c.request.payload;
    const { setSchemeStatus } = await import("@/server/dealers/scheme-admin");
    await setSchemeStatus(requester(c), str(p.schemeId, "schemeId"), str(p.to, "to") as "SUSPENDED" | "PUBLISHED" | "EXPIRED" | "ARCHIVED", c.request.reason);
  },
});

registerApprovalHandler({
  type: DEALER_FOUR_EYE_TYPES.DEALER_SCHEME_CHANGE,
  checker: "ADMIN",
  async apply(c) {
    const p = c.request.payload;
    const { changeDealerScheme } = await import("@/server/dealers/scheme-change");
    await changeDealerScheme(requester(c), str(p.dealerId, "dealerId"), str(p.versionId, "versionId"), c.request.reason);
  },
});

registerApprovalHandler({
  type: DEALER_FOUR_EYE_TYPES.FRANCHISE_REFUND,
  checker: "ADMIN",
  async apply(c) {
    const p = c.request.payload;
    const { refundBooking } = await import("@/server/franchise/booking");
    await refundBooking(str(p.bookingId, "bookingId"), c.request.reason, requester(c));
  },
});

/** Records a request for a second approver; the routes answer 202 with it. */
export async function requestDealerApproval(input: { type: keyof typeof DEALER_FOUR_EYE_TYPES; actor: ApprovalActor; subjectType: string; subjectId: string; title: string; reason: string; payload: Record<string, unknown> }) {
  const request = await submitApproval({ type: DEALER_FOUR_EYE_TYPES[input.type], actor: input.actor, subjectType: input.subjectType, subjectId: input.subjectId, title: input.title, reason: input.reason, payload: input.payload });
  return { pendingApproval: true as const, approvalId: request.id, message: "Sent for approval: a second admin approves it in Admin → Approvals." };
}
