/**
 * Approve without the FSSAI licence (owner request, 21-Nov-2026; migration 0159).
 *
 * A food shop cannot be approved without a valid FSSAI licence on file (document-uploads.ts,
 * fssaiBlocksRegistration). An admin may still approve it, with a written reason, when the owner
 * will provide the licence later. The owner then has rule documentUpload.fssaiWaiverDays (30) to
 * upload it:
 *  - while the waiver runs, the FSSAI gate (approval and profile completion) is open;
 *  - the 1st / 15th document follow-up reminds the owner and, once the due date has passed with no
 *    valid licence on file, suspends the shop (shop-document-follow-up.ts);
 *  - the legal-documents register (rule legalDocuments, when on) gets the same deadline, so the
 *    shop is not refused orders before it.
 * The licence itself can be uploaded by the owner (My Shop → Upload documents), or by an admin or
 * operator from the approval queue when the owner sends it to GoKesari.
 *
 * DF-09 (owner, 22-Nov-2026): the same waiver ("Approve without documents") covers any other document
 * the admin made must-have for the shop's type; the due date and the follow-up are the same.
 *
 * Kept apart from shop_document_waivers: a row there makes the shop KYC-complete and lifts the
 * "documents later" payout hold, which an FSSAI waiver must not do.
 */
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";

import { forbidden } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { shopFssaiWaivers, shopLegalDocuments, type Shop, type ShopFssaiWaiver, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";

const DAY_MS = 86_400_000;
const CHUNK = 500;

/** The shop's latest FSSAI waiver whose due date has not passed, or null. */
export async function activeFssaiWaiver(shopId: string, client: DbClient = db, now: Date = new Date()): Promise<ShopFssaiWaiver | null> {
  const [row] = await client
    .select()
    .from(shopFssaiWaivers)
    .where(and(eq(shopFssaiWaivers.shopId, shopId), gt(shopFssaiWaivers.dueAt, now)))
    .orderBy(desc(shopFssaiWaivers.dueAt))
    .limit(1);
  return row ?? null;
}

/** Each shop's latest FSSAI due date, passed or not (the document follow-up's input). */
export async function latestFssaiDueDates(shopIds: string[], client: DbClient = db): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  for (let i = 0; i < shopIds.length; i += CHUNK) {
    const rows = await client
      .select({ shopId: shopFssaiWaivers.shopId, dueAt: shopFssaiWaivers.dueAt })
      .from(shopFssaiWaivers)
      .where(inArray(shopFssaiWaivers.shopId, shopIds.slice(i, i + CHUNK)));
    for (const r of rows) {
      const seen = out.get(r.shopId);
      if (!seen || r.dueAt.getTime() > seen.getTime()) out.set(r.shopId, r.dueAt);
    }
  }
  return out;
}

/**
 * Records an admin's FSSAI waiver inside the approval transaction (it holds the shop's lock).
 * Admin only, with a reason; the caller has already checked that the licence is missing.
 */
export async function recordFssaiWaiver(
  tx: DbClient,
  shop: Pick<Shop, "id">,
  reason: string,
  actor: { id: string | null; role: UserRole | null },
  now: Date = new Date(),
  /** DF-09: the waiver also covers the admin's other must-have documents; `fssai: false` when FSSAI is not among them. */
  options: { fssai?: boolean } = {},
): Promise<ShopFssaiWaiver> {
  if (actor.role !== "ADMIN" || !actor.id) throw forbidden("Only an admin can approve a shop without its must-have documents.");
  const { fssaiWaiverDays } = await getRule("documentUpload");
  const dueAt = new Date(now.getTime() + fssaiWaiverDays * DAY_MS);
  const [waiver] = await tx
    .insert(shopFssaiWaivers)
    .values({ shopId: shop.id, reason: reason.trim(), waivedBy: actor.id, dueAt, createdAt: now })
    .returning();
  // The legal-documents register (when rule legalDocuments is on) reads a missing licence's
  // deadline from grace_until: give it the same date, so orders are not refused before it.
  if (options.fssai !== false) await tx.insert(shopLegalDocuments).values({ shopId: shop.id, docType: "FSSAI", graceUntil: dueAt }).onConflictDoNothing();
  if (options.fssai !== false) await tx
    .update(shopLegalDocuments)
    .set({ graceUntil: dueAt, updatedAt: now })
    .where(
      and(
        eq(shopLegalDocuments.shopId, shop.id),
        eq(shopLegalDocuments.docType, "FSSAI"),
        eq(shopLegalDocuments.licenceKey, ""),
        ne(shopLegalDocuments.status, "APPROVED"),
        ne(shopLegalDocuments.status, "SUBMITTED"),
      ),
    );
  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_APPROVED_WITHOUT_FSSAI,
      entityType: "shop",
      entityId: shop.id,
      newValue: { reason: waiver.reason, dueAt: dueAt.toISOString(), days: fssaiWaiverDays },
    },
    tx,
  );
  return waiver;
}
