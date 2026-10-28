/**
 * POST { decision: "ACCEPTED" | "REJECTED", note? } — ADMIN only: review one dealer document
 * (a rejection needs a note, which the dealer receives). docs/dealer-programme, GKS-DR-002.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { dealerView, getDealer, reviewDealerDocument } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string; docId: string }>) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const params = await context.params;
  const dealerId = z.string().uuid().parse(params.id);
  const docId = z.string().uuid().parse(params.docId);
  const body = await parseBody(request, z.object({ decision: z.enum(["ACCEPTED", "REJECTED"]), note: z.string().max(500).nullish() }));
  await reviewDealerDocument(docId, body.decision, body.note ?? null, admin);
  return ok({ dealer: await dealerView(await getDealer(dealerId)) });
});
