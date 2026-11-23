/**
 * docs/dealer-platform phase 6: an approved dealer moves to another scheme.
 *   GET                         → { options } the schemes he may move to
 *   POST { versionId, termsHash } → accepts its terms; free → applied now; a joining charge → { payment } to pay
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { conflict } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { changeOptions, requestSchemeChange } from "@/server/dealers/scheme-change";
import { getDealerForUser } from "@/server/dealers/service";
import { clientIp } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requireUser();
  const dealer = await getDealerForUser(user.id);
  if (!dealer || dealer.status !== "APPROVED") throw conflict("Only an approved dealer can change his scheme.");
  return ok({ options: await changeOptions(dealer) });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  enforceRateLimit(`dealer-scheme-change:${user.id}`, RATE_LIMITS.PAYMENT);
  const body = await parseBody(request, z.object({ versionId: z.string().uuid(), termsHash: z.string().regex(/^[0-9a-f]{64}$/) }));
  return ok(await requestSchemeChange(user, { ...body, ipAddress: clientIp(request), userAgent: request.headers.get("user-agent") }));
});
