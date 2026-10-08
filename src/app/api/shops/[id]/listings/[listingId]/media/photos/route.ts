/**
 * Add one photo to a shop product (Module 1). Multipart form, field `file`.
 * JPG, PNG or WebP up to the rule's size (5 MB); the server checks the real
 * type from the bytes, strips EXIF, makes thumbnail/medium/large WebP copies
 * and stores them outside the web root. 422 with details.reason PHOTO_LIMIT
 * when the product already has the maximum (5) photos.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { getRule } from "@/server/services/settings";
import { uploadListingPhoto } from "@/server/services/shop-media";
import { requireShopCatalogueAccess } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), listingId: z.string().uuid() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string; listingId: string }>) => {
  const { id, listingId } = ids.parse(await context.params);
  const actor = await requireShopCatalogueAccess(id);
  enforceRateLimit(`shop-media-upload:${actor.id}`, { limit: 60, windowMs: 10 * 60_000 });

  const { maxUploadBytes } = await getRule("shopProductMedia");
  const declared = Number(request.headers.get("content-length") ?? "0");
  // Multipart framing adds a little; anything far past the limit is refused unread.
  if (declared > maxUploadBytes + 64 * 1024) {
    throw validationFailed(`Each photo can be at most ${Math.round(maxUploadBytes / (1024 * 1024))} MB.`, {
      reason: "PHOTO_TOO_LARGE",
      maxBytes: maxUploadBytes,
    });
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw validationFailed("Attach a photo.");
  const photo = await uploadListingPhoto(id, listingId, Buffer.from(await file.arrayBuffer()), actor, {
    fileName: file.name.slice(0, 120),
  });
  return ok(photo, 201);
});
