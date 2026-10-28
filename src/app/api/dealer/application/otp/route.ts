/**
 * The applicant's mobile number (docs/dealer-programme): POST { action: "send" } sends a
 * one-time code by SMS; POST { action: "verify", code } checks it. Rate-limited per number and IP.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { dealerView, sendDealerMobileOtp, verifyDealerMobile } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send") }),
  z.object({ action: z.literal("verify"), code: z.string().max(10) }),
]);

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  const body = await parseBody(request, schema);
  if (body.action === "send") {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    return ok(await sendDealerMobileOtp(user, ip));
  }
  return ok({ dealer: await dealerView(await verifyDealerMobile(user, body.code)) });
});
