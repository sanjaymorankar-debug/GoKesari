/** GET ?status=PENDING_PAYMENT|APPROVED|CANCELLED|ALL → self-registrations, and payments needing support (Module 3). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listRegistrations, paymentProblems } from "@/server/registration/admin";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  const { status } = parseQuery(request, z.object({ status: z.enum(["PENDING_PAYMENT", "APPROVED", "CANCELLED", "ALL"]).default("PENDING_PAYMENT") }));
  return ok({ registrations: await listRegistrations(status), paymentProblems: await paymentProblems() });
});
