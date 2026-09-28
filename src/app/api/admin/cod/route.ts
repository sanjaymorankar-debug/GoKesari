/**
 * Cash on delivery held by riders and shops (GS-030), and recording a cash
 * deposit. COD_CASH_MANAGE (operator, admin). A deposit is limited to the
 * cash still held and cancels that much of the collection in the next batch.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listCodCashHeld, recordCodDeposit } from "@/server/services/cod";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.COD_CASH_MANAGE);
  return ok(await listCodCashHeld());
});

const schema = z.object({
  party: z.enum(["RIDER", "SHOP"]),
  id: z.string().uuid(),
  amountPaise: z.number().int().positive(),
  reference: z.string().min(3).max(120),
  requestId: z.string().min(8).max(64),
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requirePermission(PERMISSIONS.COD_CASH_MANAGE);
  const body = await parseBody(request, schema);
  return ok(await recordCodDeposit(body, actor), 201);
});
