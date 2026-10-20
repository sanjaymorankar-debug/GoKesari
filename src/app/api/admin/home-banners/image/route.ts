/**
 * A home hero banner's picture (docs/homepage-uiux-2026-10, F1): multipart `file` → stored in the image store
 * (stored_images, checked like every upload: real type, size, dimensions) and
 * served publicly at /api/images/{id} — a home banner is public by nature.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { imageUrl, saveImage } from "@/server/services/image-store";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.HOME_BANNER_MANAGE);
  enforceRateLimit(`image-upload:${user.id}`, { limit: 40, windowMs: 10 * 60_000 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw validationFailed("Attach an image file.");
  // "PRODUCT" is the image store's public purpose (served to anyone, cached); no shop product links to it.
  const image = await saveImage(Buffer.from(await file.arrayBuffer()), { purpose: "PRODUCT", ownerId: user.id });
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.IMAGE_UPLOADED,
    entityType: "stored_image",
    entityId: image.id,
    newValue: { purpose: "HOME_BANNER", bytes: image.sizeBytes, width: image.width, height: image.height },
  });
  return ok({ id: image.id, url: imageUrl(image.id), width: image.width, height: image.height }, 201);
});
