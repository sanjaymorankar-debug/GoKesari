/**
 * POST { mobile } sends an SMS code to the number the signed-in person is about to link (purpose PHONE_LINK); PUT
 * /api/me/phone then takes it as { code }. Login & auth 27-Nov-2026: whenever SMS codes can be sent; otherwise 404.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { phoneLinkNeedsCode, requestPhoneLinkCode } from "@/server/flows/phone-link";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

const schema = z.object({ mobile: z.string().min(10).max(20) });

export const POST = route(async (request: NextRequest) => {
  if (!(await phoneLinkNeedsCode())) throw new AppError("NOT_FOUND", "No code is needed to add a mobile number on this site right now.");
  const user = await requireUser();
  enforceRateLimit(`phone-link-code:${user.id}`, { limit: 10, windowMs: 15 * 60_000 });
  enforceRateLimit(clientKey(request, "phone-link-code"), { limit: 30, windowMs: 15 * 60_000 });
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  return ok(await requestPhoneLinkCode(user.id, body.mobile, ip));
});
