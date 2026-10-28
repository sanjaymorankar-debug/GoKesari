/**
 * Dealer application (docs/dealer-programme, GKS-DR-001). Any signed-in user
 * applies for themselves; one application per account.
 *
 * GET → { dealer (masked) | null, requirements by dealer type, open districts, agreement version, smsAvailable }
 * PUT { legalName, contactName, dealerType, mobile, pan?, gstin?, shopActNumber?, addressLine1, addressLine2?,
 *       city, pincode, state?, territories[], bank? } → saved as a draft
 * 404 while the dealer programme is off.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { DEALER_AGREEMENT_VERSION, DEALER_TYPES } from "@/lib/dealers";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme, smsAvailable } from "@/server/dealers/http";
import { checkDealerBank, dealerView, documentRequirements, getDealerForUser, saveApplication } from "@/server/dealers/service";
import { getFeatureFlag } from "@/server/services/feature-flags";
import { listDistricts } from "@/server/services/geo-areas";

export const dynamic = "force-dynamic";

const schema = z.object({
  legalName: z.string().max(200),
  contactName: z.string().max(200),
  dealerType: z.enum(DEALER_TYPES),
  mobile: z.string().max(20).nullish(),
  pan: z.string().max(20).nullish(),
  gstin: z.string().max(20).nullish(),
  shopActNumber: z.string().max(80).nullish(),
  addressLine1: z.string().max(200),
  addressLine2: z.string().max(200).nullish(),
  city: z.string().max(80),
  pincode: z.string().max(10),
  state: z.string().max(60).nullish(),
  territories: z.array(z.string().max(48)).max(50),
  bank: z.object({ holderName: z.string().max(200), accountNumber: z.string().max(30), ifsc: z.string().max(20) }).nullish(),
});

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requireUser();
  const dealer = await getDealerForUser(user.id);
  const flag = await getFeatureFlag("dealer_programme_enabled");
  const districts = (await listDistricts()).filter((d) => d.status === "ACTIVE" && (flag.districtCodes === null || flag.districtCodes.includes(d.code)));
  const requirements = Object.fromEntries(await Promise.all(DEALER_TYPES.map(async (t) => [t, await documentRequirements(t)] as const)));
  return ok({
    dealer: dealer ? await dealerView(dealer) : null,
    requirements,
    openDistricts: districts.map((d) => ({ code: d.code, name: d.name })),
    agreementVersion: DEALER_AGREEMENT_VERSION,
    smsAvailable: smsAvailable(),
  });
});

export const PUT = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  const body = await parseBody(request, schema);
  let dealer = await saveApplication(body, { id: user.id, role: user.role, email: user.email ?? null });
  // The bank is asked after the save (an outside call, never inside the transaction).
  if (dealer.bankStatus === "PENDING") dealer = await checkDealerBank(dealer.id, user).catch(() => dealer);
  return ok({ dealer: await dealerView(dealer) });
});
