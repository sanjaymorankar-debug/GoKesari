/**
 * Admin zone business data and fees (§5.2–§5.3):
 *   POST { action: "import", csv }                         CSV (zone code, ₹ Cr, source, as-of date) → DRAFT batch + preview
 *   POST { action: "preview", zoneSetCode, batchId? }      old vs new for every active zone (no batch = recalculation)
 *   POST { action: "publish", zoneSetCode, batchId?, reason }  publish; active franchises keep the fee they paid
 *   POST { action: "discard", batchId }
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireFranchiseAdmin } from "@/server/franchise/http";
import { discardBusinessBatch, importZoneBusiness, previewFees, publishFees } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

const set = z.string().regex(/^[A-Z]{3}$/);
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("import"), csv: z.string().min(10).max(500_000) }),
  z.object({ action: z.literal("preview"), zoneSetCode: set, batchId: z.string().uuid().nullish() }),
  z.object({ action: z.literal("publish"), zoneSetCode: set, batchId: z.string().uuid().nullish(), reason: z.string().trim().min(5).max(500) }),
  z.object({ action: z.literal("discard"), batchId: z.string().uuid() }),
]);

export const POST = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, body);
  if (b.action === "import") return ok(await importZoneBusiness(b.csv, actor));
  if (b.action === "preview") return ok(await previewFees(b.zoneSetCode, b.batchId ?? null));
  if (b.action === "publish") return ok(await publishFees(b.zoneSetCode, b.batchId ?? null, b.reason, actor));
  await discardBusinessBatch(b.batchId, actor);
  return ok({ discarded: b.batchId });
});
