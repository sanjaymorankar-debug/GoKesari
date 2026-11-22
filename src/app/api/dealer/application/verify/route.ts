/**
 * Dealer application: check a document online instead of uploading it (owner, 22-Nov-2026;
 * docs/dealer-programme/ONLINE_VERIFICATION.md).
 *
 * POST { target: "PAN" | "GSTIN" | "BANK" } → { result: { status, message }, dealer }
 * Checks the number saved in step 1. Rate-limited per user (each check may cost a vendor fee).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { verifyDealerDocumentOnline } from "@/server/dealers/online-verify";
import { dealerView, getDealerForUser } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

const schema = z.object({ target: z.enum(["PAN", "GSTIN", "BANK"]) });

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  const { target } = await parseBody(request, schema);
  const result = await verifyDealerDocumentOnline(user, target);
  const dealer = await getDealerForUser(user.id);
  return ok({ result, dealer: dealer ? await dealerView(dealer) : null });
});
