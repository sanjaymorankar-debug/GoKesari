/** F2: a rider asks to change identity / bank details — held for admin review, encrypted. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getMyLatestChangeRequest, requestSensitiveChange } from "@/server/services/rider-profile";

export const dynamic = "force-dynamic";

const field = z.string().max(120).nullish();
const schema = z
  .object({
    panNumber: field,
    governmentIdType: field,
    governmentIdNumber: field,
    bankAccountHolderName: field,
    bankAccountNumber: field,
    bankIfsc: field,
    drivingLicenceNumber: field,
  })
  .strict();

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  return ok({ request: await getMyLatestChangeRequest(user.id) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  enforceRateLimit(`rider-change-request:${user.id}`, RATE_LIMITS.MUTATION);
  const created = await requestSensitiveChange(user.id, await parseBody(request, schema));
  const { payloadEncrypted: _p, ...visible } = created;
  void _p;
  return ok(visible, 201);
});
