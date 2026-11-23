/**
 * docs/dealer-platform phase 2: the schemes an applicant may choose, his choice and its joining charge.
 *   GET            → { schemes, chosenVersionId, charge }
 *   POST { versionId } → chooses a scheme (draft or rejected application only)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { chooseScheme, chosenScheme, joiningChargeView, offeredSchemes } from "@/server/dealers/scheme-registration";
import { getDealerForUser } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requireUser();
  const dealer = await getDealerForUser(user.id);
  const chosen = dealer ? await chosenScheme(dealer) : null;
  return ok({ schemes: await offeredSchemes(), chosenVersionId: chosen?.versionId ?? null, charge: dealer ? await joiningChargeView(dealer) : null });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  enforceRateLimit(`dealer-scheme:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, z.object({ versionId: z.string().uuid() }));
  const dealer = await chooseScheme(user, body.versionId);
  return ok({ chosenVersionId: dealer.requestedVersionId, charge: await joiningChargeView(dealer) });
});
