/**
 * GET ?status=PENDING|APPROVED|…|ALL&q= — the dealer list / approval queue. Admin and operator
 * (read only). docs/dealer-programme, GKS-DR-002.
 * POST { legalName, contactName, dealerType, stateCode, districtCode? | newDistrictName?, email?,
 *        mobile?, city?, pincode?, agreementStart?, agreementEnd?, reason } — ADMIN only: add a
 *        dealer for any state and district; approved at once with its generated code.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { DEALER_STATUSES, DEALER_TYPES, type DealerStatus } from "@/lib/dealers";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { createDealerByAdmin, listDealers } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  await requireRole("ADMIN", "OPERATOR");
  const status = request.nextUrl.searchParams.get("status") ?? "ALL";
  const q = request.nextUrl.searchParams.get("q")?.slice(0, 80) ?? undefined;
  return ok({
    dealers: await listDealers({ status: (DEALER_STATUSES as readonly string[]).includes(status) ? (status as DealerStatus) : "ALL", q }),
  });
});

const createSchema = z.object({
  legalName: z.string().max(200),
  contactName: z.string().max(200),
  dealerType: z.enum(DEALER_TYPES),
  stateCode: z.string().max(4),
  districtCode: z.string().max(48).nullish(),
  newDistrictName: z.string().max(80).nullish(),
  email: z.string().max(200).nullish(),
  mobile: z.string().max(20).nullish(),
  city: z.string().max(80).nullish(),
  pincode: z.string().max(10).nullish(),
  agreementStart: z.string().max(10).nullish(),
  agreementEnd: z.string().max(10).nullish(),
  reason: z.string().max(300),
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, createSchema);
  const { dealer, code } = await createDealerByAdmin(body, admin);
  return ok({ dealer: { id: dealer.id, legalName: dealer.legalName, status: dealer.status }, code }, 201);
});
