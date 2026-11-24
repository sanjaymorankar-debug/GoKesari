/**
 * Who may do what in Delivery management (docs/hdms-2026-11). Reuses the existing permissions:
 *  - see deliveries, allocate, cancel, simulate (sandbox): DELIVERY_ORDER_MANAGE_ANY (Operations) or SYSTEM_CONFIG;
 *  - configure partners, zones, pricing, allocation rules, decide shop-rider ID proofs: SYSTEM_CONFIG (Super Admin);
 *  - see settlements: FINANCE_VIEW; create / reconcile / mark paid: SYSTEM_CONFIG.
 */
import { requireAnyPermission, requirePermission } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import type { UserRole } from "@/server/db/schema";

export const DELIVERY_VIEW = [PERMISSIONS.DELIVERY_ORDER_MANAGE_ANY, PERMISSIONS.SYSTEM_CONFIG] as const;
export const DELIVERY_FINANCE_VIEW = [PERMISSIONS.FINANCE_VIEW, PERMISSIONS.SYSTEM_CONFIG] as const;

export const requireDeliveryOps = () => requireAnyPermission(DELIVERY_VIEW);
export const requireDeliveryConfig = () => requirePermission(PERMISSIONS.SYSTEM_CONFIG);
export const requireDeliveryFinanceView = () => requireAnyPermission(DELIVERY_FINANCE_VIEW);

export function canConfigureDelivery(role: UserRole): boolean {
  return can(role, PERMISSIONS.SYSTEM_CONFIG);
}
export function canSeeDelivery(role: UserRole): boolean {
  return DELIVERY_VIEW.some((p) => can(role, p));
}
export function canSeeDeliveryFinance(role: UserRole): boolean {
  return DELIVERY_FINANCE_VIEW.some((p) => can(role, p));
}
