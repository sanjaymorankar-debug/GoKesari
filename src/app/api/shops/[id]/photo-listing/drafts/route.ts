/**
 * Add product by photo + voice (docs/smart-shopping-2026-11/FEATURE2_PRODUCT_BY_PHOTO.md).
 *   GET   the shop's open drafts (bulk mode: review them all at the end)
 *   POST  multipart: `photo` 1–4 files (front, back, label, barcode) and `side` for each, in the same order.
 *         AI reads them; the answer is a draft with every field's confidence and the master-catalogue match,
 *         or an UNREADABLE draft with the reason and a "please retake" message.
 * The shop's owner only (and support staff with PRODUCT_CREATE_ANY); 404 while shop_photo_listing_enabled is off.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { getRule } from "@/server/services/settings";
import { listPhotoListingDrafts, PHOTO_SIDES, readProductPhotos } from "@/server/services/shop-photo-listing";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid() });
const side = z.enum(PHOTO_SIDES).catch("OTHER");

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = ids.parse(await context.params);
  const user = await requireUser();
  return ok(await listPhotoListingDrafts(id, user));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = ids.parse(await context.params);
  const user = await requireUser();
  // AI reads cost money: at most 20 products a quarter-hour per person (the daily AI limit also applies).
  enforceRateLimit(`photo-listing-read:${user.id}`, { limit: 20, windowMs: 15 * 60_000 });
  const rule = await getRule("smartShopping");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > rule.maxPhotosPerProduct * rule.maxUploadMb * 1024 * 1024 + 256 * 1024) {
    throw validationFailed(`Each photo can be at most ${rule.maxUploadMb} MB.`, { reason: "PHOTO_TOO_LARGE" });
  }
  const form = await request.formData().catch(() => null);
  const files = (form?.getAll("photo") ?? []).filter((f): f is File => f instanceof File && f.size > 0);
  const sides = form?.getAll("side") ?? [];
  if (files.length === 0) throw validationFailed("Take at least one photo of the product.");
  const photos = await Promise.all(
    files.map(async (file, i) => ({ bytes: Buffer.from(await file.arrayBuffer()), side: side.parse(sides[i] ?? (i === 0 ? "FRONT" : "OTHER")) })),
  );
  return ok(await readProductPhotos(id, user, photos), 201);
});
