/**
 * Owner, 28-Nov-2026: a dealer's request to become a super dealer is approved or rejected by ONE admin or operator
 * (never the person who raised it). src/server/dealers/super-requests.ts.
 */
import { SUPER_DEALER_REQUEST, SUPER_REQUEST_DECIDER_ROLES, applySuperRequest, onSuperRequestRejected } from "@/server/dealers/super-requests";

import { registerApprovalHandler } from "./engine";

registerApprovalHandler({
  type: SUPER_DEALER_REQUEST,
  checker: "ADMIN",
  deciderRoles: SUPER_REQUEST_DECIDER_ROLES,
  strictFourEye: true,
  async apply(context) {
    await applySuperRequest(context.request, context.decidedBy);
  },
  async onRejected(request) {
    await onSuperRequestRejected(request);
  },
});
