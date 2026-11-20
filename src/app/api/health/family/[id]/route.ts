/** POST { action: confirm {code} | resend | remove } for a family record I manage. */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { bodyOf, str, uuidParam } from "@/server/health/http";
import { confirmFamilyLink, removeFamilyMember, resendFamilyCode } from "@/server/health/patients";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = await uuidParam(context, "id");
  const body = await bodyOf(request);
  enforceRateLimit(`health-family-action:${user.id}`, RATE_LIMITS.MUTATION);
  switch (body.action) {
    case "confirm": {
      const p = await confirmFamilyLink(id, str(body, "code") ?? "", user);
      return ok({ linkStatus: p.linkStatus });
    }
    case "resend": {
      const r = await resendFamilyCode(id, user);
      return ok({ codeSentTo: r.codeSentTo });
    }
    case "remove":
      await removeFamilyMember(id, user);
      return ok({ removed: true });
    default:
      throw validationFailed("Unknown action.");
  }
});
