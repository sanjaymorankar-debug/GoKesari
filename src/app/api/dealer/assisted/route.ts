/**
 * Dealer-assisted shop registration, step 1 (docs/dealer-programme, GKS-SH-002).
 * POST { ownerName, ownerMobile, ownerEmail, salespersonId? } → a one-time code goes to the OWNER
 * (SMS to their mobile; email where SMS is not set up). GET → this dealer's assisted registrations.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listAssistedSessions, startAssistedRegistration } from "@/server/dealers/assisted";
import { requireDealerProgramme } from "@/server/dealers/http";
import { requireApprovedDealer } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  return ok({ sessions: await listAssistedSessions(await requireApprovedDealer(user)) });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  enforceRateLimit(`dealer-assisted:${user.id}`, { limit: 30, windowMs: 60 * 60_000 });
  const dealer = await requireApprovedDealer(user);
  const body = await parseBody(
    request,
    z.object({ ownerName: z.string().max(200), ownerMobile: z.string().max(20), ownerEmail: z.string().max(254), salespersonId: z.string().uuid().nullish() }),
  );
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return ok({ session: await startAssistedRegistration(dealer, body, user, ip) }, 201);
});
