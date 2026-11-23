/**
 * POST { agreementVersion, termsHash? } — the applicant accepts the dealer agreement and his scheme's terms (the
 * fingerprint of the terms he saw; docs/dealer-platform phase 2) and submits
 * (DRAFT → PENDING). docs/dealer-programme, GKS-DR-001.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme, smsAvailable } from "@/server/dealers/http";
import { clientIp } from "@/server/franchise/http";
import { dealerView, submitApplication } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  const body = await parseBody(request, z.object({ agreementVersion: z.string().max(20), termsHash: z.string().regex(/^[0-9a-f]{64}$/).nullish() }));
  const dealer = await submitApplication(user, body.agreementVersion, { smsAvailable: smsAvailable(), termsHash: body.termsHash ?? null, ipAddress: clientIp(request), userAgent: request.headers.get("user-agent") });
  return ok({ dealer: await dealerView(dealer) });
});
