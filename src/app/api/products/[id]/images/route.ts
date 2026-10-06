/**
 * Product photos.
 *   GET  ?shopProductId=  the photos shown for a product (the listing's own if it has any, else the product's)
 *   POST { storedImageId, shopProductId?, altText? }  attach an uploaded photo (upload first with POST /api/images, purpose PRODUCT)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { getCurrentUser, requireUser } from "@/server/authz/guards";
import { addImage, canManageImages, galleryFor, listImages } from "@/server/services/product-images";

export const dynamic = "force-dynamic";

const uuid = z.string().uuid();

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const raw = new URL(request.url).searchParams.get("shopProductId");
  const shopProductId = raw && uuid.safeParse(raw).success ? raw : null;
  const scope = new URL(request.url).searchParams.get("scope");
  // F10: unapproved photos only go to someone who manages this scope.
  const images =
    scope === "own"
      ? await listImages(id, shopProductId, undefined, {
          approvedOnly: !(await canManageImages(await getCurrentUser(), id, shopProductId)),
        })
      : await galleryFor(id, shopProductId);
  return ok({
    images: images.map((i) => ({
      id: i.id,
      url: i.url,
      altText: i.altText,
      isPrimary: i.isPrimary,
      sortOrder: i.sortOrder,
      shopProductId: i.shopProductId,
      moderationStatus: i.moderationStatus,
      rejectionReason: i.rejectionReason,
    })),
  });
});

const schema = z.object({
  storedImageId: uuid,
  shopProductId: uuid.nullish(),
  altText: z.string().max(200).nullish(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await addImage({ productId: id, ...body }, user), 201);
});
