/**
 * "Registration successful — ready for product upload" (docs/dealer-programme,
 * GKS-SH-004): sent to the owner when a shop is approved instantly on GST/PAN
 * verification + payment, in the app and by email (the notification outbox
 * retries a failed email; the approval never depends on it), with the shop ID
 * and direct links to add products. The dealer the shop is counted for is told
 * too.
 */
import { eq } from "drizzle-orm";

import { addDays, formatDisplayDate, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { listJoin } from "@/lib/shop-document-rules";
import { licenceGraceMessage } from "@/lib/shop-licences";
import { db } from "@/server/db";
import { dealers, shopAttributions, type Shop } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { notify } from "./notifications";
import { getRule } from "./settings";
import { isDocumentsLaterShop, isWizardRegisteredShop } from "./shop-onboarding";
import { documentRequirementsFor, requirementsOnFile } from "./shop-document-rules";
import { loadShopTypeRegistry } from "./shop-types";

function siteUrl(path: string): string {
  const base = (getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
  return `${base}${path}`;
}

/**
 * DI-14 (owner, 08-Nov-2026): a shop type with a mandatory licence (drug licence, medical or
 * professional registration) goes live without it; the owner has shopDocumentFollowUp.graceDays (90)
 * to upload it — since DF-08 (21-Nov-2026) on the owner's promise, whose date applies when later.
 * Not FSSAI any more (DF-08): a food shop goes live only with its licence on file, or on an admin's
 * waiver, which sends its own notice (shops.ts). DF-09 (22-Nov-2026): the licences are the admin's
 * rules — the licences and admin-added documents set to "on the promise" for the shop's type.
 * Once per shop (dedupe key).
 */
async function sendLicenceGraceNotice(shop: Shop, labels: string[]): Promise<void> {
  const { graceDays } = await getRule("shopDocumentFollowUp");
  const zone = getEnv().APP_TIMEZONE;
  const graceEnd = addDays(todayIn(zone), graceDays);
  const promised = shop.documentsDueAt ? todayIn(zone, shop.documentsDueAt) : null;
  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.SHOP_LICENCE_GRACE_NOTICE,
    vars: {
      shopName: shop.name,
      graceDays,
      message: licenceGraceMessage(listJoin(labels), graceDays).en,
      dueDate: formatDisplayDate(promised && promised > graceEnd ? promised : graceEnd),
    },
    actionUrl: "/shop/legal-documents",
    dedupeKey: `shop-licence-grace:${shop.id}`,
    mandatory: true,
  });
}

/**
 * DI-14 again, for a shop registered through the wizard that went live another way — an admin's
 * Approve (a shop held before 21-Nov-2026 for its FSSAI licence, D-151) or the documents rule —
 * while its licence is still not on file: the same grace notice as an instant approval.
 */
export async function sendLicenceGraceNoticeIfMissing(shop: Shop): Promise<void> {
  try {
    if (!(await isWizardRegisteredShop(shop.id))) return;
    await loadShopTypeRegistry();
    // FSSAI is on file before a food shop goes live (DF-08); an admin's waiver sends its own notice. Shop
    // Act and Udyam are seller documents with their own reminders.
    const requirements = (await documentRequirementsFor(shop)).filter((r) => r.kind !== "seller" && r.level === "PROMISE");
    if (requirements.length === 0) return;
    const missing = (await requirementsOnFile(shop, db, { requirements })).filter((r) => !r.onFile).map((r) => r.label);
    if (missing.length > 0) await sendLicenceGraceNotice(shop, missing);
  } catch (error) {
    console.error("[shop-ready] licence notice failed", shop.id, error instanceof Error ? error.message : error);
  }
}

export async function sendReadyForProductUpload(shop: Shop): Promise<void> {
  try {
    // A shop registered with "add documents later" had no GST / PAN check (onboarding Phase B, G10).
    const later = await isDocumentsLaterShop(shop.id);
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_READY_FOR_PRODUCT_UPLOAD,
      vars: {
        shopName: shop.name,
        shopId: shop.registrationNumber ?? shop.id,
        addProductsUrl: siteUrl("/shop/manage/products"),
        bulkUploadUrl: siteUrl("/shop/product-import"),
        checkedLine: later
          ? "Your registration fee is received,"
          : "Your GST/PAN was verified with the government records and your registration fee is received,",
        payoutLine: later ? ". Add your GST number or PAN on Documents before your first payout — payouts start once it is verified." : "",
      },
      actionUrl: "/shop/manage/products",
      dedupeKey: `shop-ready:${shop.id}`,
    });
    // Only a wizard shop whose licence is still missing (a licence no longer stops other shops' approval).
    await sendLicenceGraceNoticeIfMissing(shop);
    const [attributed] = await db
      .select({ userId: dealers.userId, isInternal: dealers.isInternal })
      .from(shopAttributions)
      .innerJoin(dealers, eq(dealers.id, shopAttributions.dealerId))
      .where(eq(shopAttributions.shopId, shop.id));
    if (attributed?.userId && !attributed.isInternal) {
      await notify({
        userId: attributed.userId,
        type: NOTIFICATION_TYPES.DEALER_SHOP_APPROVED,
        vars: { shopName: shop.name },
        actionUrl: "/dealer",
        dedupeKey: `dealer-shop-approved:${shop.id}`,
      });
    }
  } catch (error) {
    // The shop is approved whatever happens here; notify() itself queues and retries delivery.
    console.error("[shop-ready] notice failed", shop.id, error instanceof Error ? error.message : error);
  }
}
