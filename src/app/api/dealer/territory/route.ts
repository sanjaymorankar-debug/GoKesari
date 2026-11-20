/**
 * The territory dealer's own territories (docs/dealer-programme/TERRITORY_DEALER.md).
 *
 * GET → my territories: pincodes, paid-up date, rating and share, this month's order income so far, fees.
 * POST { territoryId } → pay the territory fee online: a gateway checkout; the territory is paid up only
 *     when the gateway's signed webhook confirms the payment.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireDealerProgramme } from "@/server/dealers/http";
import { getDealerForUser } from "@/server/dealers/service";
import { payTerritoryFeeOnline, territoryViews } from "@/server/dealers/territory";

export const dynamic = "force-dynamic";

async function myDealer(userId: string) {
  const dealer = await getDealerForUser(userId);
  if (!dealer || dealer.status !== "APPROVED") throw forbidden("Only an approved dealer has territories.");
  return dealer;
}

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requireUser();
  const dealer = await myDealer(user.id);
  return ok({ territories: await territoryViews(dealer.id) });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  await myDealer(user.id);
  enforceRateLimit(`territory-fee-pay:${user.id}`, RATE_LIMITS.PAYMENT);
  const body = await parseBody(request, z.object({ territoryId: z.string().uuid() }));
  const created = await payTerritoryFeeOnline(body.territoryId, user);
  const checkoutUrl = created.checkout ? (created.checkout.kind === "HOSTED_URL" ? created.checkout.url : (created.checkout.url ?? null)) : null;
  return ok({ intentId: created.intent.id, checkoutUrl });
});
