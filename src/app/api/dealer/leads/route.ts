/**
 * The dealer's leads (docs/dealer-programme, GKS-RA-001). Approved dealers only, own leads only.
 * GET → leads (open first; expired ones marked) · POST { shopName, ownerName?, mobile, gstin?, pincode,
 * latitude?, longitude?, salespersonId?, ownerConsent: true, consentNote? } → an open lead for the window.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireDealerProgramme } from "@/server/dealers/http";
import { createLead, listLeads } from "@/server/dealers/leads";
import { requireApprovedDealer } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

const schema = z.object({
  shopName: z.string().max(200),
  ownerName: z.string().max(200).nullish(),
  mobile: z.string().max(20),
  gstin: z.string().max(20).nullish(),
  pincode: z.string().max(10),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  salespersonId: z.string().uuid().nullish(),
  ownerConsent: z.boolean(),
  consentNote: z.string().max(300).nullish(),
});

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  const dealer = await requireApprovedDealer(user);
  return ok({ leads: await listLeads(dealer.id) });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  enforceRateLimit(`dealer-lead:${user.id}`, { limit: 60, windowMs: 60 * 60_000 });
  const dealer = await requireApprovedDealer(user);
  const body = await parseBody(request, schema);
  return ok({ lead: await createLead(dealer, body, user) }, 201);
});
