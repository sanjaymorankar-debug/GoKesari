/**
 * docs/shop-welcome-kit-2026-11 (26-Nov-2026): the payment QR on the shop banner's "Pay here (UPI)" panel.
 * The shop's owner and operations (shop:update:any) only.
 *
 *   POST multipart `file` (photo or screenshot, ≤ 5 MB) → the QR is read and checked (UPI, no fixed amount);
 *                                                          its text is saved, the photo is not kept.
 *   DELETE                                              → back to the UPI ID from accounts settings.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { clearBannerUpiQr, MAX_UPI_QR_BYTES, saveBannerUpiQr } from "@/server/shop-banner/upi-qr";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  enforceRateLimit(`banner-upi-qr:${user.id}`, { limit: 20, windowMs: 60 * 60_000 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_UPI_QR_BYTES + 512 * 1024) throw validationFailed("The image is larger than 5 MB.");
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) throw validationFailed("Choose a photo or screenshot of your payment QR.");
  if (file.type && !/^image\//.test(file.type)) throw validationFailed("Upload an image (JPG or PNG) of your payment QR.");
  return ok(await saveBannerUpiQr(id, Buffer.from(await file.arrayBuffer()), user.id));
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  await clearBannerUpiQr(id, user.id);
  return ok({ removed: true });
});
