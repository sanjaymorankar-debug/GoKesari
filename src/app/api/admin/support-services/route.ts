/**
 * Support services administration (docs/dealer-programme, GKS-SP-001).
 * GET → charges (every version), settings, requests and the report by service. Admin and operator.
 * POST { action: "saveCharge", serviceKey, charge, reason } | { action: "settings", patch, reason }
 *      | { action: "refund", requestId, amountPaise, reason } → ADMIN only (checked again in the service).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { AppError } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { SUPPORT_CHARGE_MODELS } from "@/server/db/schema";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { adminRefund, getSupportSettings, listCharges, saveCharge, saveSupportSettings, supportServicesReport } from "@/server/services/support-services";

export const dynamic = "force-dynamic";

async function requireOn() {
  if (!(await isFeatureEnabled("paid_support_services_enabled"))) throw new AppError("NOT_FOUND", "This feature is not available.", { reason: "FEATURE_NOT_AVAILABLE" });
}

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("saveCharge"),
    serviceKey: z.enum(["GENERAL", "PRODUCT_UPLOAD", "PRICE_UPDATE"]),
    reason: z.string().max(500),
    charge: z.object({
      chargeModel: z.enum(SUPPORT_CHARGE_MODELS),
      amountPaise: z.number().int(),
      batchSize: z.number().int().nullish(),
      gstApplicable: z.boolean(),
      gstRateBp: z.number().int(),
      freeQuotaPerMonth: z.number().int(),
      effectiveFrom: z.string().max(10),
      effectiveTo: z.string().max(10).nullish(),
    }),
  }),
  z.object({ action: z.literal("settings"), reason: z.string().max(500), patch: z.object({ refundPercentBeforeWork: z.number().int().optional(), freeForManagedBilling: z.boolean().optional() }) }),
  z.object({ action: z.literal("refund"), requestId: z.string().uuid(), amountPaise: z.number().int(), reason: z.string().max(300) }),
]);

export const GET = route(async () => {
  await requireOn();
  await requireRole("ADMIN", "OPERATOR");
  const [charges, settings, report] = await Promise.all([listCharges(), getSupportSettings(), supportServicesReport()]);
  return ok({ charges, settings, ...report });
});

export const POST = route(async (request: NextRequest) => {
  await requireOn();
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, schema);
  if (body.action === "saveCharge") return ok({ charge: await saveCharge(body.serviceKey, body.charge, body.reason, admin) });
  if (body.action === "settings") return ok({ settings: await saveSupportSettings(body.patch, body.reason, admin) });
  return ok({ request: await adminRefund(body.requestId, body.amountPaise, body.reason, admin) });
});
