/** One add-by-photo draft: GET for review, DELETE to discard it (its photos are deleted at once). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { discardPhotoListingDraft, getPhotoListingDraft } from "@/server/services/shop-photo-listing";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), draftId: z.string().uuid() });

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string; draftId: string }>) => {
  const { id, draftId } = ids.parse(await context.params);
  const user = await requireUser();
  return ok(await getPhotoListingDraft(id, user, draftId));
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string; draftId: string }>) => {
  const { id, draftId } = ids.parse(await context.params);
  const user = await requireUser();
  enforceRateLimit(`photo-listing-mutate:${user.id}`, RATE_LIMITS.MUTATION);
  await discardPhotoListingDraft(id, user, draftId);
  return noContent();
});
