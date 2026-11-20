/**
 * Festival collections (brief §6): GET → all; POST { festivalKey, title, titleHi?, titleMr?,
 * subtitle?, startsAt, endsAt (ISO instants; the screen enters IST), active?, showOnHome? }.
 * showOnHome also schedules a home-page banner for the same dates.
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listFestivalCollections, saveFestivalCollection } from "@/server/puja/admin";
import { festivalSchema } from "@/server/puja/route-helpers";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.HOME_BANNER_MANAGE);
  return ok({ collections: await listFestivalCollections() });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.HOME_BANNER_MANAGE);
  return ok(await saveFestivalCollection(null, await parseBody(request, festivalSchema), user), 201);
});
