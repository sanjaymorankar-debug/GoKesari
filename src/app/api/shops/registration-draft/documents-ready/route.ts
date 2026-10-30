/** Shop registration (0120): POST { later } — "Do you have your documents handy?" (later: upload them after go-live). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { answerDocumentsReady, requireWizardAvailable } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const schema = z.object({ later: z.boolean() });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  // Only while the wizard flag is on (an admin may use it while it is off): the screen is not the only gate.
  await requireWizardAvailable(user);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await answerDocumentsReady({ actor: user, later: body.later }));
});
