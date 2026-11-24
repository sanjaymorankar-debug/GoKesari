/**
 * docs/tax-register: change requests to tax settings.
 * GET  ?status=  → the requests (Accountant, CA, admin)
 * POST { kind, payload, reason, legalReference?, csv? } → propose (Accountant, admin). For HSN_RATES
 *      and PRODUCT_GST a CSV may be sent instead of payload.rows.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { parseHsnCsv } from "@/server/gst/config";
import { listTaxChanges, parseProductGstCsv, proposeSchema, proposeTaxChange } from "@/server/tax-register/changes";

export const dynamic = "force-dynamic";

const schema = proposeSchema.extend({ payload: z.record(z.string(), z.unknown()).default({}), csv: z.string().max(2_000_000).optional() });

export const GET = route(async (request: NextRequest) => {
  await requireAnyPermission([PERMISSIONS.TAX_PARAM_PROPOSE, PERMISSIONS.TAX_PARAM_APPROVE]);
  return ok({ changes: await listTaxChanges({ status: request.nextUrl.searchParams.get("status") ?? undefined }) });
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireAnyPermission([PERMISSIONS.TAX_PARAM_PROPOSE]);
  const { csv, ...body } = await parseBody(request, schema);
  if (csv && body.kind === "HSN_RATES") body.payload = { rows: parseHsnCsv(csv) };
  if (csv && body.kind === "PRODUCT_GST") body.payload = { rows: parseProductGstCsv(csv) };
  return ok(await proposeTaxChange(body, actor), 201);
});
