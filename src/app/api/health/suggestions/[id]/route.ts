/** POST { action: share {share: boolean} | dismiss } on a doctor's suggestion in my record. */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { bodyOf, uuidParam } from "@/server/health/http";
import { dismissSuggestion, setSuggestionShare } from "@/server/health/records";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = await uuidParam(context, "id");
  const body = await bodyOf(request);
  if (body.action === "share") await setSuggestionShare(id, body.share === true, user);
  else if (body.action === "dismiss") await dismissSuggestion(id, user);
  else throw validationFailed("Unknown action.");
  return ok({ ok: true });
});
