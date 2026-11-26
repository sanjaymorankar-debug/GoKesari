/**
 * docs/referral-sharing-2026-11: a Share button was pressed. POST { code, channel } — logged for the
 * signed-in owner of the code only (anyone else's code is ignored). Always 200, so a share never fails
 * because of the log.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SHARE_CHANNELS } from "@/lib/referral-share";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { logShare, referralSharingOn } from "@/server/services/referral-links";

export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().trim().min(4).max(40), channel: z.enum(SHARE_CHANNELS) });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`referral-share:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  if (!(await referralSharingOn())) return ok({ logged: false });
  return ok({ logged: await logShare(user.id, body.code, body.channel) });
});
