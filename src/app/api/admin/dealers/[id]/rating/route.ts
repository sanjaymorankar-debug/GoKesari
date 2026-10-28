/**
 * A dealer's onboarding rating (docs/dealer-programme, GKS-CM-003).
 * GET → rating, bonus, next slab, history (admin and operator).
 * POST { action: "START" | "DOWNGRADE" | "RECOUNT", rating?, reason } → ADMIN only, audited.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { downgradeRating, ratingView, recountRating, setStartRating } from "@/server/dealers/commission";
import { requireDealerProgramme } from "@/server/dealers/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  await requireRole("ADMIN", "OPERATOR");
  return ok({ rating: await ratingView(z.string().uuid().parse((await context.params).id)) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const id = z.string().uuid().parse((await context.params).id);
  const body = await parseBody(request, z.object({ action: z.enum(["START", "DOWNGRADE", "RECOUNT"]), rating: z.number().optional(), reason: z.string().max(500) }));
  if (body.action === "START") await setStartRating(id, body.rating ?? NaN, body.reason, admin);
  else if (body.action === "DOWNGRADE") await downgradeRating(id, body.rating ?? NaN, body.reason, admin);
  else await recountRating(id, body.reason || "recount by an admin", admin);
  return ok({ rating: await ratingView(id) });
});
