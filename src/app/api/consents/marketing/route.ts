/**
 * Marketing-communications consent (GS-070; DPDPA 2023 §6).
 *
 * GET returns the signed-in user's current choice and its history; PUT
 * records a new grant or withdrawal. Withdrawal is as easy as granting
 * (§6(4)), and every change is a new row — the history is never rewritten.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import {
  getMarketingConsentStatus,
  setMarketingConsent,
} from "@/server/services/consents";

const schema = z.object({ granted: z.boolean() });

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await getMarketingConsentStatus(user.id));
});

export const PUT = route(async (request: NextRequest) => {
  const user = await requireUser();
  const body = await parseBody(request, schema);
  const forwarded = request.headers.get("x-forwarded-for");
  await setMarketingConsent(user.id, body.granted, {
    ipAddress: forwarded?.split(",")[0]?.trim() || null,
  });
  return ok(await getMarketingConsentStatus(user.id));
});
