/**
 * docs/shop-welcome-kit-2026-11 (owner brief 26-Nov-2026, optional item): the owner may upload the payment QR they
 * already use (PhonePe, Paytm, Google Pay, BharatPe, a bank's merchant QR …) for the banner's "Pay here (UPI)"
 * panel. The photo itself is not kept: its QR is read (accounts/qr-decode.ts, the same reader as bill capture),
 * checked to be a UPI payment QR (render.ts parseUpiQr: upi://pay, a valid payee address, no fixed amount), and
 * its text is stored in inv_settings.banner_upi_qr. The banner redraws it as a crisp QR of the same text, so a
 * blurry photo still prints sharp. Without an upload the banner uses the UPI ID from accounts settings.
 */
import { eq } from "drizzle-orm";

import { validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { invSettings } from "@/server/db/schema";
import { getSettings } from "@/server/accounts/books";
import { findQrCodes } from "@/server/accounts/qr-decode";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

import { parseUpiQr } from "./render";

export const MAX_UPI_QR_BYTES = 5 * 1024 * 1024;

export interface BannerUpiQr {
  vpa: string;
  payeeName: string | null;
}

/** The QR on the photo, if it is a UPI payment QR fit for the banner; a clear error otherwise. */
export async function readUpiQrImage(image: Buffer): Promise<{ payload: string } & BannerUpiQr> {
  if (image.length === 0) throw validationFailed("Choose a photo or screenshot of your payment QR.");
  if (image.length > MAX_UPI_QR_BYTES) throw validationFailed("The image is larger than 5 MB.");
  const codes = await findQrCodes(image);
  if (codes.length === 0) throw validationFailed("No QR code could be read on this image. Upload a clear, straight photo or screenshot of the QR.");
  for (const code of codes) {
    const upi = parseUpiQr(code);
    if (upi) return upi;
  }
  if (codes.some((code) => /^upi:\/\/pay\?/i.test(code.trim()) && /[?&]am=\d*[1-9]/i.test(code))) {
    throw validationFailed("This QR asks for a fixed amount. Upload the shop's general payment QR (no amount), which customers can use for any bill.");
  }
  throw validationFailed("This is not a UPI payment QR. Upload the QR you use to receive payments (it starts with upi://pay).");
}

/** Saves the uploaded payment QR for the shop's banner (owner or operations). */
export async function saveBannerUpiQr(shopId: string, image: Buffer, actorId: string): Promise<BannerUpiQr> {
  const upi = await readUpiQrImage(image);
  await getSettings(shopId);
  await db.update(invSettings).set({ bannerUpiQr: upi.payload, updatedBy: actorId, updatedAt: new Date() }).where(eq(invSettings.shopId, shopId));
  await recordAudit({
    actorId,
    action: AUDIT_ACTIONS.SHOP_BANNER_UPI_QR_CHANGED,
    entityType: "shop",
    entityId: shopId,
    newValue: { vpa: upi.vpa, payeeName: upi.payeeName },
  });
  return { vpa: upi.vpa, payeeName: upi.payeeName };
}

/** Removes the uploaded payment QR: the banner falls back to the UPI ID from accounts settings. */
export async function clearBannerUpiQr(shopId: string, actorId: string): Promise<void> {
  await db.update(invSettings).set({ bannerUpiQr: null, updatedBy: actorId, updatedAt: new Date() }).where(eq(invSettings.shopId, shopId));
  await recordAudit({ actorId, action: AUDIT_ACTIONS.SHOP_BANNER_UPI_QR_CHANGED, entityType: "shop", entityId: shopId, newValue: { removed: true } });
}

/** What the Marketing page shows: the uploaded QR's payee, or null. */
export async function bannerUpiQrInfo(shopId: string): Promise<BannerUpiQr | null> {
  const [row] = await db.select({ qr: invSettings.bannerUpiQr }).from(invSettings).where(eq(invSettings.shopId, shopId));
  const upi = row?.qr ? parseUpiQr(row.qr) : null;
  return upi ? { vpa: upi.vpa, payeeName: upi.payeeName } : null;
}
