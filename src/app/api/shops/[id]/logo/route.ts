/**
 * docs/delta CF-011 (D-144): the shop owner uploads a logo file after onboarding.
 *   POST   multipart form `file` (JPEG / PNG / WebP) → stored like a product photo, set as the shop's logo
 *   DELETE clears the logo
 * Behind the feature flag `shop_logo_upload_enabled` (OFF unless an admin switches it on; a missing
 * row counts as OFF). The logo is written through the existing `updateShop`, exactly as the shop
 * settings API writes `logoUrl` today; the wizard and every other screen are unchanged.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { requireFeatureForShop } from "@/server/services/feature-flags";
import { imageUrl, saveImage } from "@/server/services/image-store";
import { toShopView, updateShop } from "@/server/services/shops";
import { SHOP_LOGO_FLAG } from "@/lib/delta/shop-logo";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  await requireFeatureForShop(SHOP_LOGO_FLAG, id);
  enforceRateLimit(`shop-logo:${user.id}`, { limit: 10, windowMs: 10 * 60_000 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw validationFailed("Attach an image file.");

  // Same checks as every other upload: real type from the bytes, size and pixel limits (rule images).
  const image = await saveImage(Buffer.from(await file.arrayBuffer()), { purpose: "PRODUCT", ownerId: user.id });
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.IMAGE_UPLOADED,
    entityType: "stored_image",
    entityId: image.id,
    newValue: { purpose: "SHOP_LOGO", shopId: id, bytes: image.sizeBytes, width: image.width, height: image.height },
  });
  const shop = await updateShop(id, { logoUrl: imageUrl(image.id) }, user);
  return ok({ logoUrl: shop.logoUrl, shop: toShopView(shop) }, 201);
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  await requireFeatureForShop(SHOP_LOGO_FLAG, id);
  const shop = await updateShop(id, { logoUrl: null }, user);
  return ok({ logoUrl: shop.logoUrl, shop: toShopView(shop) });
});
