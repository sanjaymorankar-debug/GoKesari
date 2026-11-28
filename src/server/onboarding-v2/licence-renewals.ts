/**
 * Owner, 28-Nov-2026 (~11.50 IST): an EXPIRED licence at an onboarding v2 / v3 registration no longer blocks signing
 * or go-live. The owner promises to renew it; the shop goes live and the existing documents follow-up (rule
 * shopDocumentFollowUp: reminders on the 1st / 15th, suspension after the deadline, automatic reinstatement once a
 * valid licence is uploaded) chases the renewal exactly like a missing promised licence.
 *
 * The promise is a registration licence entry (option LATER, status PROMISED) with `expired_on` (the expiry date the
 * owner was shown) and `renewal_promised_at`, plus an audit entry naming who, when, which licence and the date. The
 * shop's documents promise (documents_promised_at / documents_due_at) is set if it was not already.
 * DEFAULT – confirm with Sanjay: the renewal period is the same as a missing promised licence (promiseDays).
 *
 * Only registrations: a live shop keeps the current seller-agreement and licence rules (requirements.ts).
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "@/server/db";
import { registrationLicenceEntries, shopRegistrationDrafts, shops, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { setDocumentsPromise } from "@/server/services/shop-document-gate";

export type RenewalToPromise = { key: string; label: string; expiredOn: string };

/** Records the renewal promise of each expired licence of a shop whose v2 / v3 registration is at its agreement step. */
export async function recordRenewalPromises(
  shopId: string,
  renewals: RenewalToPromise[],
  actor: { userId: string; role: UserRole | null; ip: string | null },
): Promise<number> {
  if (renewals.length === 0) return 0;
  const [draft] = await db
    .select()
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.shopId, shopId), eq(shopRegistrationDrafts.flowVersion, "v2")))
    .limit(1);
  if (!draft) return 0;
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const r of renewals) {
      const values = {
        draftId: draft.id,
        ownerUserId: draft.ownerId,
        shopId,
        licenceKey: r.key,
        option: "LATER" as const,
        status: "PROMISED" as const,
        statusReason: `Expired on ${r.expiredOn}: the owner promised to renew it.`,
        promiseAcceptedAt: now,
        expiredOn: r.expiredOn,
        renewalPromisedAt: now,
        verifiedAt: null,
        updatedAt: now,
      };
      await tx
        .insert(registrationLicenceEntries)
        .values(values)
        .onConflictDoUpdate({ target: [registrationLicenceEntries.draftId, registrationLicenceEntries.licenceKey], set: values });
    }
    const [shop] = await tx.select({ promisedAt: shops.documentsPromisedAt }).from(shops).where(eq(shops.id, shopId)).for("update");
    if (shop && !shop.promisedAt) await setDocumentsPromise(tx, shopId, now);
    await tx
      .update(shopRegistrationDrafts)
      .set({ documentsPromisedAt: draft.documentsPromisedAt ?? now, updatedAt: now })
      .where(eq(shopRegistrationDrafts.id, draft.id));
  });
  for (const r of renewals) {
    await recordAudit({
      actorId: actor.userId,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_REGISTRATION_LICENCE_RENEWAL_PROMISED,
      entityType: "shop",
      entityId: shopId,
      ipAddress: actor.ip,
      newValue: { draftId: draft.id, licenceKey: r.key, label: r.label, expiredOn: r.expiredOn, promisedAt: now.toISOString() },
    });
  }
  return renewals.length;
}

/** The licence keys of these shops that carry an open renewal promise (for the documents follow-up). */
export async function openRenewalKeys(shopIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (shopIds.length === 0) return out;
  const rows = await db
    .select({ shopId: registrationLicenceEntries.shopId, licenceKey: registrationLicenceEntries.licenceKey })
    .from(registrationLicenceEntries)
    .where(and(inArray(registrationLicenceEntries.shopId, shopIds), eq(registrationLicenceEntries.status, "PROMISED"), isNotNull(registrationLicenceEntries.renewalPromisedAt)));
  for (const r of rows) {
    if (!r.shopId) continue;
    if (!out.has(r.shopId)) out.set(r.shopId, new Set());
    out.get(r.shopId)!.add(r.licenceKey);
  }
  return out;
}
