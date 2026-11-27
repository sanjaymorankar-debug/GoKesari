/**
 * docs/flows-v3/wave3.md (F4, flag flow_f4): the optional shop contact offered on the v2 agreement step.
 *   JSON       { whatsappNumber }            the shop's WhatsApp number ("" clears it)
 *   multipart  whatsappNumber?, qr (image)   and / or the shop's payment QR (photo or screenshot; read and checked
 *                                            as a UPI payment QR, used on the welcome-kit banner)
 * 404 while the flag (or rule shopFlowsV3.askContactAtRegistration) is off. Answers with the saved contact.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { wizardActor } from "@/server/api/wizard-actor";
import { saveRegistrationContact } from "@/server/flows/f4-onboarding";
import { MAX_UPI_QR_BYTES } from "@/server/shop-banner/upi-qr";

export const dynamic = "force-dynamic";

const schema = z.object({ whatsappNumber: z.string().trim().max(20).nullish() });

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    if (Number(request.headers.get("content-length") ?? "0") > MAX_UPI_QR_BYTES + 512 * 1024) throw validationFailed("The image is larger than 5 MB.");
    const form = await request.formData().catch(() => null);
    if (!form) throw validationFailed("Choose a photo or screenshot of your payment QR.");
    const number = form.get("whatsappNumber");
    const qr = form.get("qr");
    const qrImage = qr instanceof File && qr.size > 0 ? Buffer.from(await qr.arrayBuffer()) : null;
    return ok(await saveRegistrationContact(user, { whatsappNumber: typeof number === "string" ? number : undefined, qrImage }));
  }
  const body = await parseBody(request, schema);
  return ok(await saveRegistrationContact(user, { whatsappNumber: body.whatsappNumber ?? "" }));
});
