/**
 * A credit or debit note on GoKesari's fee invoice, by hand
 * (PLATFORM_INVOICE_MANAGE). It is settled through the shop's next payout
 * cycle (credit +, debit −). `requestId` makes a double submit harmless.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { PLATFORM_FEE_TYPES } from "@/server/db/schema";
import { issuePlatformNoteByAdmin } from "@/server/platform-invoices/service";

const schema = z.object({
  invoiceId: z.string().uuid(),
  kind: z.enum(["CREDIT", "DEBIT"]),
  feeType: z.enum(PLATFORM_FEE_TYPES),
  taxablePaise: z.number().int().positive().max(1_000_000_000),
  reason: z.string().trim().min(3).max(300),
  requestId: z.string().min(8).max(80),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PLATFORM_INVOICE_MANAGE);
  const body = await parseBody(request, schema);
  return ok(await issuePlatformNoteByAdmin(body, user), 201);
});
