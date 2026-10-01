/**
 * One product photo.
 *   PATCH { action: "primary" }                     make it the primary photo
 *   PATCH { action: "replace", storedImageId }      swap the file, keep its place
 *   PATCH { action: "alt", altText }                edit the description
 *   DELETE                                          remove it (the next photo becomes primary if needed)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { deleteImage, replaceImage, setPrimaryImage, updateAltText } from "@/server/services/product-images";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("primary") }),
  z.object({ action: z.literal("replace"), storedImageId: z.string().uuid() }),
  z.object({ action: z.literal("alt"), altText: z.string().max(200).nullable() }),
]);

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string; imageId: string }>) => {
  const user = await requireUser();
  const { id, imageId } = await context.params;
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "primary":
      await setPrimaryImage(id, imageId, user);
      return ok({ saved: true });
    case "replace":
      return ok(await replaceImage(id, imageId, body.storedImageId, user));
    case "alt":
      await updateAltText(id, imageId, body.altText, user);
      return ok({ saved: true });
  }
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string; imageId: string }>) => {
  const user = await requireUser();
  const { id, imageId } = await context.params;
  await deleteImage(id, imageId, user);
  return ok({ deleted: true });
});
