/**
 * POST { agreementVersion } — the applicant accepts the dealer agreement and submits
 * (DRAFT → PENDING). docs/dealer-programme, GKS-DR-001.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme, smsAvailable } from "@/server/dealers/http";
import { dealerView, submitApplication } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  const body = await parseBody(request, z.object({ agreementVersion: z.string().max(20) }));
  const dealer = await submitApplication(user, body.agreementVersion, { smsAvailable: smsAvailable() });
  return ok({ dealer: await dealerView(dealer) });
});
