/**
 * WhatsApp updates consent (docs/customer-whatsapp-2026-11/README.md; DPDPA 2023 §6).
 *
 * GET returns the signed-in customer's choice; PUT records a grant or a
 * withdrawal as a new row (source PROFILE). Withdrawing is as easy as granting.
 * A grant needs a verified mobile number (WhatsApp goes to that number).
 * Flag whatsapp_customer_enabled off: 404, as if the route did not exist.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { featureNotAvailable, isFeatureEnabled } from "@/server/services/feature-flags";
import { CUSTOMER_WHATSAPP_FLAG } from "@/server/whatsapp/customer/config";
import { getWhatsAppConsentStatus, setWhatsAppConsent, verifiedPhoneOf } from "@/server/whatsapp/customer/consent";

const schema = z.object({ granted: z.boolean() });

async function requireFlag(): Promise<void> {
  if (!(await isFeatureEnabled(CUSTOMER_WHATSAPP_FLAG))) throw featureNotAvailable(CUSTOMER_WHATSAPP_FLAG);
}

export const GET = route(async () => {
  const user = await requireUser();
  await requireFlag();
  return ok(await getWhatsAppConsentStatus(user.id));
});

export const PUT = route(async (request: NextRequest) => {
  const user = await requireUser();
  await requireFlag();
  const body = await parseBody(request, schema);
  if (body.granted) {
    if (!(await verifiedPhoneOf(user.id))) {
      throw validationFailed("Add and verify your mobile number first: WhatsApp updates go to that number.");
    }
  }
  const forwarded = request.headers.get("x-forwarded-for");
  return ok(await setWhatsAppConsent(user.id, body.granted, { source: "PROFILE", ipAddress: forwarded?.split(",")[0]?.trim() || null }));
});
