/**
 * Merge a duplicate master product into another (brief §6): POST { sourceId, targetId, reason? }.
 * The duplicate is retired; shops that list it keep their listings and order history.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { mergeMasterProducts } from "@/server/puja/admin";
import { requirePujaStaff } from "@/server/puja/route-helpers";

export const dynamic = "force-dynamic";

const schema = z.object({ sourceId: z.string().uuid(), targetId: z.string().uuid(), reason: z.string().trim().max(300).nullish() });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePujaStaff();
  const body = await parseBody(request, schema);
  return ok(await mergeMasterProducts(body.sourceId, body.targetId, user, body.reason));
});
