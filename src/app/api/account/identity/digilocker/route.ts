/**
 * docs/identity-verification-2026-11: "Verify with Aadhaar (DigiLocker)" —
 * after consent, a DigiLocker link (the rider flow's session handling,
 * server/kyc/digilocker-session.ts). `app`: the app build's URL scheme when the
 * page runs inside the GoKesari app, so DigiLocker's return hands back to it.
 * 404 while neither identity switch (customers / shop owners) applies to the caller.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { startIdentityDigilocker } from "@/server/services/identity-verification";

export const dynamic = "force-dynamic";

const schema = z.object({ consent: z.boolean(), app: z.string().max(40).nullish() });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`identity-digilocker:${user.id}`, { limit: 10, windowMs: 60 * 60_000 });
  const body = await parseBody(request, schema);
  return ok(
    await startIdentityDigilocker(user.id, {
      consentGiven: body.consent,
      app: body.app ?? null,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      userAgent: request.headers.get("user-agent"),
    }),
  );
});
