/**
 * Territory dealers (docs/dealer-programme/TERRITORY_DEALER.md) — the admin screen's API.
 *
 * GET → every territory (pincodes, fees, rating, this month so far), the TIERED dealers that can be
 *     given one, and rule territoryDealer. ADMIN and OPERATOR.
 * POST { action, … } — ADMIN only; every change is audited:
 *   create {dealerId, name, pincodes, feePaise} — an exclusive territory, waiting for its first fee
 *   pincodes {territoryId, add, remove, reason} — add pincodes (refused if another territory holds one) / release some
 *   fee {territoryId, feePaise, reason} — the yearly fee for the next payment
 *   recordPayment {territoryId, reference} — a fee paid outside the website (UTR, cheque number)
 *   cancel {territoryId, reason} — ends it now and releases its pincodes
 *   rate {territoryId} — works out today's rating now (the daily job does it every morning)
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import {
  cancelTerritory,
  changeTerritoryPincodes,
  createTerritory,
  rateTerritory,
  recordOfflineFee,
  setTerritoryFee,
  territoryCandidates,
  territoryRule,
  territoryViews,
} from "@/server/dealers/territory";

export const dynamic = "force-dynamic";

const id = z.string().uuid();
const reason = z.string().max(500);
const pincodes = z.array(z.string().max(10)).max(500);
const fee = z.number().int().min(100).max(1_000_000_000);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), dealerId: id, name: z.string().max(120), pincodes, feePaise: fee }),
  z.object({ action: z.literal("pincodes"), territoryId: id, add: pincodes, remove: pincodes, reason }),
  z.object({ action: z.literal("fee"), territoryId: id, feePaise: fee, reason }),
  z.object({ action: z.literal("recordPayment"), territoryId: id, reference: z.string().max(120) }),
  z.object({ action: z.literal("cancel"), territoryId: id, reason }),
  z.object({ action: z.literal("rate"), territoryId: id }),
]);

export const GET = route(async () => {
  await requireDealerProgramme();
  await requireRole("ADMIN", "OPERATOR");
  const [territories, dealers, rule] = await Promise.all([territoryViews(null), territoryCandidates(), territoryRule()]);
  return ok({ territories, dealers, rule });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "create":
      return ok({ territory: await createTerritory({ dealerId: body.dealerId, name: body.name, pincodes: body.pincodes, feePaise: body.feePaise }, admin) });
    case "pincodes":
      return ok(await changeTerritoryPincodes(body.territoryId, { add: body.add, remove: body.remove, reason: body.reason }, admin));
    case "fee":
      return ok({ territory: await setTerritoryFee(body.territoryId, body.feePaise, body.reason, admin) });
    case "recordPayment":
      return ok({ territory: await recordOfflineFee(body.territoryId, { reference: body.reference }, admin) });
    case "cancel":
      return ok({ territory: await cancelTerritory(body.territoryId, body.reason, admin) });
    case "rate":
      return ok(await rateTerritory(body.territoryId));
  }
});
