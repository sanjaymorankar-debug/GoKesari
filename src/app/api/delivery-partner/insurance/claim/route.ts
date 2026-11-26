/**
 * Raise a rider insurance claim (Rider App v2, rule riderInsurance) — opens a help-desk ticket.
 *   POST {description, incidentDate? (YYYY-MM-DD)} → {id, ticketNumber}
 * Files are then added with POST /api/support/tickets/{id}/attachments.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { raiseInsuranceClaim } from "@/server/services/rider-insurance";

export const dynamic = "force-dynamic";

const schema = z.object({
  description: z.string().min(10).max(4000),
  incidentDate: z.string().max(10).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  enforceRateLimit(`rider-insurance-claim:${user.id}`, { limit: 5, windowMs: 10 * 60_000 });
  const body = await parseBody(request, schema);
  return ok(await raiseInsuranceClaim(user, body), 201);
});
