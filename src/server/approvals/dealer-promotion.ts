/**
 * Owner, 28-Nov-2026: a shop owner's promotion to dealer / franchisee is four-eye (src/server/dealers/promotion.ts).
 * An admin's Approve records the request; a DIFFERENT admin or operator confirms it, and only then the dealer is
 * approved (GKD code, DEALER role, role history, e-mail). Strict: never the requester, not even a lone Super Admin.
 * Always on for these promotions, independent of flag dealer_platform_four_eye.
 */
import { DEALER_PROMOTION_APPROVAL, PROMOTION_CONFIRMER_ROLES, applyConfirmedPromotion, onPromotionRejected } from "@/server/dealers/promotion";

import { registerApprovalHandler } from "./engine";

registerApprovalHandler({
  type: DEALER_PROMOTION_APPROVAL,
  checker: "ADMIN",
  deciderRoles: PROMOTION_CONFIRMER_ROLES,
  strictFourEye: true,
  async apply(context) {
    await applyConfirmedPromotion(context.request, context.decidedBy);
  },
  async onRejected(request) {
    await onPromotionRejected(request);
  },
});
