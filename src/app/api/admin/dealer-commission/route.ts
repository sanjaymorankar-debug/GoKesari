/**
 * Dealer commission administration (docs/dealer-programme, GKS-CM-001…003).
 *
 * GET ?dealerId=&status= → rules (current and earlier versions), settings, rating slabs, ledger, payouts.
 *     Admin and operator (read only).
 * POST { action, … } → ADMIN only (the services check the role again; anyone else gets 403):
 *   saveRule {rule, reason} · disableRule {ruleKey, reason} · settings {patch, reason}
 *   dealerRates {dealerId, commissionPercentBp, ratingStepBp, reason} (null: the default)
 *   saveSlab {minShops, rating, reason} · deleteSlab {minShops, reason}
 *   approve {ids, capOverride?, reason?} · reverse {id, reason} · release {id, reason}
 *   createPayout {dealerId, note?} · payoutPaid {batchId, reference} · cancelPayout {batchId}
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { COMMISSION_MILESTONES, COMMISSION_STATUSES } from "@/server/db/schema";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import {
  approveEntries,
  cancelPayout,
  createPayoutBatch,
  deleteRatingSlab,
  disableCommissionRule,
  getCommissionSettings,
  listCommissionRules,
  listLedger,
  listPayouts,
  listRatingSlabs,
  markPayoutPaid,
  releaseHeldEntry,
  reverseEntry,
  saveCommissionRule,
  saveRatingSlab,
  setCommissionSettings,
  setDealerCommissionRates,
} from "@/server/dealers/commission";
import { requireDealerProgramme } from "@/server/dealers/http";

export const dynamic = "force-dynamic";

const reason = z.string().max(500);
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("saveRule"),
    reason,
    rule: z.object({
      ruleKey: z.string().uuid().nullish(),
      shopScope: z.enum(["STANDARD", "WHOLESALE", "ALL"]),
      districtCode: z.string().max(48).nullish(),
      milestone: z.enum(COMMISSION_MILESTONES),
      fixedPaise: z.number().int(),
      percentBp: z.number().int(),
      effectiveFrom: z.string().max(10),
      effectiveTo: z.string().max(10).nullish(),
    }),
  }),
  z.object({ action: z.literal("disableRule"), ruleKey: z.string().uuid(), reason }),
  z.object({
    action: z.literal("settings"),
    reason,
    patch: z.object({
      capPaise: z.number().int().optional(),
      fixedBonusBase: z.enum(["FEE", "BASE_AMOUNT"]).optional(),
      catalogueMinProducts: z.number().int().optional(),
      branchEligible: z.boolean().optional(),
      commissionModel: z.enum(["BASE_PERCENT", "MILESTONE_RULES"]).optional(),
      basePercentBp: z.number().int().optional(),
      ratingStepBp: z.number().int().optional(),
    }),
  }),
  z.object({
    action: z.literal("dealerRates"),
    dealerId: z.string().uuid(),
    commissionPercentBp: z.number().int().nullable(),
    ratingStepBp: z.number().int().nullable(),
    reason,
  }),
  z.object({ action: z.literal("saveSlab"), minShops: z.number().int(), rating: z.number(), reason }),
  z.object({ action: z.literal("deleteSlab"), minShops: z.number().int(), reason }),
  z.object({ action: z.literal("approve"), ids: z.array(z.string().uuid()).max(500), capOverride: z.boolean().optional(), reason: reason.optional() }),
  z.object({ action: z.literal("reverse"), id: z.string().uuid(), reason }),
  z.object({ action: z.literal("release"), id: z.string().uuid(), reason }),
  z.object({ action: z.literal("createPayout"), dealerId: z.string().uuid(), note: z.string().max(300).nullish() }),
  z.object({ action: z.literal("payoutPaid"), batchId: z.string().uuid(), reference: z.string().max(120) }),
  z.object({ action: z.literal("cancelPayout"), batchId: z.string().uuid() }),
]);

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  await requireRole("ADMIN", "OPERATOR");
  const params = request.nextUrl.searchParams;
  const dealerId = z.string().uuid().safeParse(params.get("dealerId")).data;
  const statusRaw = params.get("status");
  const status = (COMMISSION_STATUSES as readonly string[]).includes(statusRaw ?? "") ? (statusRaw as (typeof COMMISSION_STATUSES)[number]) : undefined;
  const [rules, settings, slabs, ledger, payouts] = await Promise.all([
    listCommissionRules({ all: true }),
    getCommissionSettings(),
    listRatingSlabs(),
    listLedger({ dealerId, status }),
    listPayouts(dealerId),
  ]);
  return ok({ rules, settings, slabs, ledger, payouts });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "saveRule":
      return ok({ rule: await saveCommissionRule(body.rule, body.reason, admin) });
    case "disableRule":
      await disableCommissionRule(body.ruleKey, body.reason, admin);
      return ok({ done: true });
    case "settings":
      return ok({ settings: await setCommissionSettings(body.patch, body.reason, admin) });
    case "dealerRates": {
      const dealer = await setDealerCommissionRates(body.dealerId, { commissionPercentBp: body.commissionPercentBp, ratingStepBp: body.ratingStepBp }, body.reason, admin);
      // Only the rates: the dealer row also carries encrypted PAN and bank details.
      return ok({ dealerId: dealer.id, commissionPercentBp: dealer.commissionPercentBp, ratingStepBp: dealer.ratingStepBp });
    }
    case "saveSlab":
      await saveRatingSlab(body.minShops, body.rating, body.reason, admin);
      return ok({ slabs: await listRatingSlabs() });
    case "deleteSlab":
      await deleteRatingSlab(body.minShops, body.reason, admin);
      return ok({ slabs: await listRatingSlabs() });
    case "approve":
      return ok({ approved: await approveEntries(body.ids, admin, { capOverride: body.capOverride, reason: body.reason }) });
    case "reverse":
      await reverseEntry(body.id, body.reason, admin);
      return ok({ done: true });
    case "release":
      await releaseHeldEntry(body.id, body.reason, admin);
      return ok({ done: true });
    case "createPayout":
      return ok({ batch: await createPayoutBatch(body.dealerId, admin, body.note) });
    case "payoutPaid":
      return ok({ batch: await markPayoutPaid(body.batchId, body.reference, admin) });
    case "cancelPayout":
      await cancelPayout(body.batchId, admin);
      return ok({ done: true });
  }
});
