/**
 * Audit log reads (§11, §17, §19).
 *
 * Kept separate from `audit.ts` — that file is the *write* path used inside
 * transactions everywhere; this one is the query path used by the console, and
 * mixing them would drag joins into every mutation's import graph.
 *
 * §17 grades visibility: an admin sees everything, an operator sees only the
 * operational surface they work on. That filter is applied here rather than in
 * the page, so a future second caller cannot forget it.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { auditLogs, users, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS } from "./audit";

/**
 * What an OPERATOR may see. Everything financial-configuration or
 * identity-related (fee schedule changes, role changes, wallet adjustments) is
 * deliberately absent.
 */
const OPERATOR_VISIBLE_ACTIONS: readonly string[] = [
  AUDIT_ACTIONS.SHOP_REGISTERED,
  AUDIT_ACTIONS.SHOP_APPROVED,
  AUDIT_ACTIONS.SHOP_REJECTED,
  AUDIT_ACTIONS.SHOP_SUSPENDED,
  AUDIT_ACTIONS.SHOP_UPDATED,
  AUDIT_ACTIONS.SHOP_CLASSIFICATION_CHANGED,
  AUDIT_ACTIONS.SHOP_REGISTRATION_UPDATED,
  AUDIT_ACTIONS.PRODUCT_PRICE_CHANGED,
  AUDIT_ACTIONS.PRODUCT_AVAILABILITY_CHANGED,
  AUDIT_ACTIONS.PRODUCT_CREATED,
  AUDIT_ACTIONS.PRODUCT_REMOVED,
  AUDIT_ACTIONS.PRICE_REQUEST_SUBMITTED,
  AUDIT_ACTIONS.PRICE_REQUEST_APPROVED,
  AUDIT_ACTIONS.PRICE_REQUEST_REJECTED,
  AUDIT_ACTIONS.EXCEL_UPLOADED,
  AUDIT_ACTIONS.EXCEL_APPLIED,
  AUDIT_ACTIONS.EXCEL_CANCELLED,
  AUDIT_ACTIONS.SHOP_PAYMENT_RECORDED,
  AUDIT_ACTIONS.REFERRAL_CODE_CREATED,
  AUDIT_ACTIONS.REFERRAL_CODE_ASSIGNED,
  // An operator's own product creations, yes; the admin publish/reject
  // DECISION stays admin-only-visible, same treatment as every other
  // admin-gated approval in this list.
  AUDIT_ACTIONS.GLOBAL_PRODUCT_CREATED,
  // Voucher upload is an OPERATOR capability (§37); manual create/edit
  // (VOUCHER_CREATED/UPDATED/ACTIVATED/DEACTIVATED) stays admin-only-visible,
  // matching every other admin-gated action in this list.
  AUDIT_ACTIONS.VOUCHER_UPLOADED,
  AUDIT_ACTIONS.VOUCHER_UPLOAD_APPLIED,
  AUDIT_ACTIONS.VOUCHER_REDEEMED,
];

export interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorRole: UserRole | null;
  previousValue: unknown;
  newValue: unknown;
  createdAt: Date;
}

export async function listAuditLog(
  viewerRole: UserRole,
  options: { entityType?: string; entityId?: string; limit?: number } = {},
): Promise<AuditRow[]> {
  const conditions = [];

  if (viewerRole !== "ADMIN") {
    conditions.push(inArray(auditLogs.action, [...OPERATOR_VISIBLE_ACTIONS]));
  }
  if (options.entityType) {
    conditions.push(eq(auditLogs.entityType, options.entityType));
  }
  if (options.entityId) {
    conditions.push(eq(auditLogs.entityId, options.entityId));
  }

  const rows = await db
    .select({
      log: auditLogs,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));

  return rows.map((r) => ({
    id: r.log.id,
    action: r.log.action,
    entityType: r.log.entityType,
    entityId: r.log.entityId,
    actorName: r.actorName,
    actorEmail: r.actorEmail,
    actorRole: r.log.actorRole,
    previousValue: r.log.previousValue,
    newValue: r.log.newValue,
    createdAt: r.log.createdAt,
  }));
}

/** Recent audit activity count, for the admin KPI row (§23). */
export async function countRecentAuditActivity(hours = 24): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`CAST(COUNT(*) AS SIGNED)` })
    .from(auditLogs)
    .where(sql`${auditLogs.createdAt} > NOW() - interval ${hours} hour`);
  return row?.n ?? 0;
}
