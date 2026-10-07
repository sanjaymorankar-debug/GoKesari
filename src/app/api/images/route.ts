/**
 * Image upload (multipart form: `file`, `purpose`).
 *   RETURN_EVIDENCE — any signed-in customer, for their own return photos
 *   PRODUCT         — a shop owner or catalogue staff, for product photos
 *   PROFILE_PHOTO   — a delivery partner, for their own profile photo (F2)
 * The browser shrinks images first; the server validates them again.
 */
import type { NextRequest } from "next/server";

import { forbidden, validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { imageUrl, saveImage } from "@/server/services/image-store";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`image-upload:${user.id}`, { limit: 40, windowMs: 10 * 60_000 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const purpose = form?.get("purpose");
  if (!(file instanceof File)) throw validationFailed("Attach an image file.");
  if (purpose !== "RETURN_EVIDENCE" && purpose !== "PRODUCT" && purpose !== "PROFILE_PHOTO") {
    throw validationFailed("Unknown image purpose.");
  }
  // F2: a rider's own profile photo.
  if (purpose === "PROFILE_PHOTO" && !can(user.role, PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN)) {
    throw forbidden("You cannot upload a profile photo.");
  }
  if (
    purpose === "PRODUCT" &&
    !can(user.role, PERMISSIONS.SHOP_PRODUCT_MANAGE_OWN) &&
    !can(user.role, PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY) &&
    !can(user.role, PERMISSIONS.PRODUCT_MANAGE)
  ) {
    throw forbidden("You cannot upload product images.");
  }
  if (purpose === "RETURN_EVIDENCE" && !can(user.role, PERMISSIONS.ORDER_CANCEL_OWN)) {
    throw forbidden("You cannot upload return photos.");
  }

  const image = await saveImage(Buffer.from(await file.arrayBuffer()), { purpose, ownerId: user.id });
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.IMAGE_UPLOADED,
    entityType: "stored_image",
    entityId: image.id,
    newValue: { purpose, bytes: image.sizeBytes, width: image.width, height: image.height },
  });
  return ok({ id: image.id, url: imageUrl(image.id), width: image.width, height: image.height, sizeBytes: image.sizeBytes }, 201);
});
