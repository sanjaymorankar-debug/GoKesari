/**
 * Onboarding wizard step 1, no GSTIN: POST { pan, declaration: true,
 * consent: true } checks the PAN with the government source and records the
 * "not GST-registered" declaration (reviewed by an admin once the shop exists).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { submitDraftPan } from "@/server/services/shop-registration-draft";
import { getWizardDraft, requireWizardAvailable } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const schema = z.object({
  pan: z.string().trim().min(1).max(20),
  declaration: z.literal(true, { message: "Please confirm that the shop is not registered under GST." }),
  consent: z.literal(true, { message: "Please agree to the verification consent." }),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  // D-106: only while the wizard flag is on (an admin may use it while it is off), as the later steps —
  // this step makes paid government lookups, so the screen must not be the only gate.
  await requireWizardAvailable(user);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  await submitDraftPan({
    pan: body.pan,
    declarationAccepted: body.declaration,
    consentGiven: body.consent,
    actor: user,
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
  });
  // The whole wizard, so the screen moves on to the next step from one answer.
  return ok(await getWizardDraft(user));
});
