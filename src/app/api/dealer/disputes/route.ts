/**
 * Attribution claims (docs/dealer-programme, GKS-RA-001). GET → the dealer's own claims.
 * POST { mobile, note, leadId? } → a claim and a help-desk ticket; the answer never says whether
 * a shop with that mobile exists.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listDisputes, raiseDispute } from "@/server/dealers/disputes";
import { requireDealerProgramme } from "@/server/dealers/http";
import { getDealerForUser } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await getDealerForUser(user.id);
  if (!dealer) throw notFound("Dealer");
  return ok({ disputes: await listDisputes({ dealerId: dealer.id }) });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  enforceRateLimit(`dealer-dispute:${user.id}`, { limit: 10, windowMs: 60 * 60_000 });
  const dealer = await getDealerForUser(user.id);
  if (!dealer) throw notFound("Dealer");
  const body = await parseBody(request, z.object({ mobile: z.string().max(20), note: z.string().max(2000), leadId: z.string().uuid().nullish() }));
  await raiseDispute(dealer, body, user);
  return ok({ received: true }, 201);
});
