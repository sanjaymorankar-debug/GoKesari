/**
 * Shop registration (owner, 21-Nov-2026): POST — the documents screen between creating the shop and
 * paying is done ("Continue to payment"). DF-08 (the same night): a food shop's FSSAI licence must be
 * on file first, and `promise: true` is the owner's tick for the other mandatory documents ("I will
 * upload them within <promiseDays> days"). The uploads themselves go through the shop's own document
 * routes (/api/shops/{id}/documents/…).
 */
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { wizardActor } from "@/server/api/wizard-actor";
import { finishDraftDocumentsStep } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const schema = z.object({ promise: z.boolean().optional() }).strict();

export const POST = route(async (request: Request) => {
  const user = await wizardActor(request);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  // No body (the screen as it was before DF-08) is the same as no promise.
  const text = await request.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw validationFailed("Request body must be valid JSON.");
    }
  }
  const body = schema.parse(raw);
  return ok(await finishDraftDocumentsStep({ actor: user, promise: body.promise === true }));
});
