/**
 * Policy re-consent for the signed-in user (docs/policy-reconsent-2026-11).
 *
 * GET  → { enabled, needsReconsent, pending[] } — the site's re-consent page and
 *        the mobile app read the same answer.
 * POST { accept: [{ doc, version }], path? } → records the acceptance and
 *        returns the new state. 409 when a newer version was published while
 *        the page was open.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { channelFor } from "@/lib/policy-reconsent";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { POLICY_DOCS } from "@/server/db/schema";
import { acceptPolicies, getReconsentState } from "@/server/services/policy-versions";

const schema = z.object({
  accept: z.array(z.object({ doc: z.enum(POLICY_DOCS), version: z.string().min(1).max(40) })).min(1).max(POLICY_DOCS.length),
  /** The page the user accepted on, for the channel (shop, rider or dealer portal). */
  path: z.string().max(300).optional(),
});

export const GET = route(async () => {
  const user = await requireUser();
  const state = await getReconsentState(user.id);
  return ok(state);
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  const body = await parseBody(request, schema);
  const userAgent = request.headers.get("user-agent");
  const forwarded = request.headers.get("x-forwarded-for");
  const state = await acceptPolicies(user.id, {
    accept: body.accept,
    channel: body.path === undefined && !userAgent?.includes("Mozilla") ? "API" : channelFor(body.path, userAgent),
    ipAddress: forwarded?.split(",")[0]?.trim() || null,
    userAgent,
  });
  return ok(state);
});
