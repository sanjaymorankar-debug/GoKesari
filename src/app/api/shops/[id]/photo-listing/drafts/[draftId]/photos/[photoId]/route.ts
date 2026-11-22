/** A photo of an add-by-photo draft, for the review screen: the shop's owner only, never cached publicly. */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { readPhotoListingPhoto } from "@/server/services/shop-photo-listing";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), draftId: z.string().uuid(), photoId: z.string().uuid() });

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string; draftId: string; photoId: string }>) => {
  const { id, draftId, photoId } = ids.parse(await context.params);
  const user = await requireUser();
  const photo = await readPhotoListingPhoto(id, user, draftId, photoId);
  return new NextResponse(new Uint8Array(photo.bytes), {
    headers: { "Content-Type": photo.contentType, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
});
