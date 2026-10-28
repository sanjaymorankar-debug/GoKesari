/**
 * Territory areas (docs/dealer-programme, step 1).
 *
 * GET ?parent=CODE | ?level=DISTRICT | ?pincode=411038  → areas below a parent, of a level,
 *     or the area a PIN code maps to (signed in; no personal data)
 * POST { code, name, level, parentCode, shortCode?, status?, pincodePrefixes? } → ADMIN only
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole, requireUser } from "@/server/authz/guards";
import { GEO_LEVELS } from "@/server/db/schema";
import { areaForPincode, listGeoAreas, saveGeoArea } from "@/server/services/geo-areas";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  code: z.string().max(48),
  name: z.string().max(80),
  level: z.enum(GEO_LEVELS),
  parentCode: z.string().max(48),
  shortCode: z.string().max(4).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  pincodePrefixes: z.array(z.string().max(6)).max(200).optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requireUser();
  const params = request.nextUrl.searchParams;
  const pincode = params.get("pincode");
  if (pincode) return ok({ place: await areaForPincode(pincode) });
  const level = params.get("level");
  const areas = await listGeoAreas({
    parentCode: params.get("parent") ?? undefined,
    level: (GEO_LEVELS as readonly string[]).includes(level ?? "") ? (level as (typeof GEO_LEVELS)[number]) : undefined,
  });
  return ok({ areas });
});

export const POST = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, postSchema);
  return ok({ area: await saveGeoArea(body, admin) });
});
