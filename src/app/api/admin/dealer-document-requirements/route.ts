/**
 * Which documents each dealer type must upload (docs/dealer-programme, GKS-DR-002).
 * GET — admin and operator. PUT { dealerType, docType, required } — ADMIN only, audited.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { DEALER_DOC_TYPES, DEALER_TYPES } from "@/lib/dealers";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { listDocumentRequirements, setDocumentRequirement } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDealerProgramme();
  await requireRole("ADMIN", "OPERATOR");
  return ok({ requirements: await listDocumentRequirements() });
});

export const PUT = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, z.object({ dealerType: z.enum(DEALER_TYPES), docType: z.enum(DEALER_DOC_TYPES), required: z.boolean() }));
  await setDocumentRequirement(body.dealerType, body.docType, body.required, admin);
  return ok({ requirements: await listDocumentRequirements() });
});
