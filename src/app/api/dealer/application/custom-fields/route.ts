/**
 * docs/dealer-platform phase 5: the chosen scheme's own questions on the application.
 *   GET            → { fields, values, files }
 *   PUT { values } → saves the answers (required ones are checked on submit)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { applicationCustomFields, saveCustomValues } from "@/server/dealers/custom-fields";
import { requireDealerProgramme } from "@/server/dealers/http";
import { getDealerForUser } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requireUser();
  const dealer = await getDealerForUser(user.id);
  if (!dealer) throw validationFailed("Save your details first.");
  return ok(await applicationCustomFields(dealer));
});

export const PUT = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  enforceRateLimit(`dealer-custom:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, z.object({ values: z.record(z.string().max(30), z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(80)).max(50), z.null()])) }));
  return ok({ values: await saveCustomValues(user, body.values) });
});
