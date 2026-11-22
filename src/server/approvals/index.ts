/**
 * RBAC v2 approvals (docs/rbac). Import from here, not from ./engine, so every handler is
 * registered before a request is decided.
 */
import "./admin-actions";
import "@/server/rbac-accounting/journals"; // Phase 3 handlers: JOURNAL_ENTRY, JOURNAL_ENTRY_HIGH_VALUE
import "@/server/rbac-accounting/rates"; // Phase 3 handler: RATE_CHANGE
import "@/server/rbac-support/change-requests"; // Phase 5 handlers: SHOP_CHANGE, MASTER_DATA_CORRECTION
import "@/server/rbac-support/documents"; // documents: DOCUMENT_DELETE (two admins)

export * from "./engine";
export {
  FOUR_EYE_TYPES,
  EMERGENCY_CONFIRM_HOURS,
  emergencySuspend,
  fourEyeAdminOn,
  requestFourEye,
  type PendingApprovalResponse,
} from "./admin-actions";
