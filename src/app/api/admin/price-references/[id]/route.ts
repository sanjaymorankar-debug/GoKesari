/**
 * One reference price.
 *   GET    → its history (created, edited, verified, rejected, reopened)
 *   PATCH  { action: "verify" | "reject" | "reopen", note? }   decide it
 *   PATCH  { action: "edit", ...fields }                       edit while unverified
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { decideReference, getReferenceHistory, updateReference } from "@/server/services/price-references";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("verify"), note: z.string().max(500).nullish() }),
  z.object({ action: z.literal("reject"), note: z.string().min(3).max(500) }),
  z.object({ action: z.literal("reopen"), note: z.string().max(500).nullish() }),
  z.object({
    action: z.literal("edit"),
    pricePaise: z.number().int().positive().optional(),
    unitBasis: z.string().max(100).nullish(),
    sourceType: z.enum(["MARKET_SURVEY", "MANUFACTURER", "GOVT_MANDI", "PARTNER_FEED", "PMD_IMPORT", "OTHER"]).optional(),
    sourceName: z.string().min(1).max(120).optional(),
    sourceIdentifier: z.string().max(120).nullish(),
    referenceUrl: z.string().url().max(500).nullish(),
    marketLocation: z.string().max(120).nullish(),
    pincode: z.string().regex(/^\d{6}$/).nullish(),
    referencedAt: z.string().datetime().optional(),
  }),
]);

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requirePermission(PERMISSIONS.PRICE_REFERENCE_MANAGE);
  const { id } = await context.params;
  return ok({ history: await getReferenceHistory(id) });
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.PRICE_REFERENCE_MANAGE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "verify":
      return ok(await decideReference(id, "VERIFIED", body.note ?? null, user));
    case "reject":
      return ok(await decideReference(id, "REJECTED", body.note, user));
    case "reopen":
      return ok(await decideReference(id, "UNVERIFIED", body.note ?? null, user));
    case "edit": {
      const { action: _a, referencedAt, ...rest } = body;
      void _a;
      return ok(await updateReference(id, { ...rest, ...(referencedAt ? { referencedAt: new Date(referencedAt) } : {}) }, user));
    }
  }
});
