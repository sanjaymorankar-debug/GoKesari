/**
 * Account recovery after losing ONE factor (docs/flows-v3/wave5.md, F18; flag flow_f18 — 404 while it is off).
 * Public: the person cannot sign in.
 *   { action: "start",    lost: "MOBILE" | "EMAIL", contact }                 → a code to the contact still working
 *   { action: "verify",   lost, contact, code, taxId? }                       → { token } (shop owners: GSTIN or PAN)
 *   { action: "new-code", token, value }                                      → a code to the new mobile / e-mail
 *   { action: "confirm",  token, value, code }                                → saved; signed out on every device
 * "start" is limited per address (rule flowsWave5.recoveryPerIpPerHour) on top of the per-contact code limits.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { confirmNewContact, sendNewContactCode, startRecovery, verifyRecovery } from "@/server/flows/account-recovery";
import { flowF18On } from "@/server/flows/wave5-flags";
import { featureNotAvailable } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

const lost = z.enum(["MOBILE", "EMAIL"]);
const code = z.string().trim().regex(/^\d{4,8}$/, "Enter the 6-digit code.");
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), lost, contact: z.string().trim().min(3).max(200) }),
  z.object({ action: z.literal("verify"), lost, contact: z.string().trim().min(3).max(200), code, taxId: z.string().trim().max(20).nullish() }),
  z.object({ action: z.literal("new-code"), token: z.string().min(10).max(400), value: z.string().trim().min(3).max(200) }),
  z.object({ action: z.literal("confirm"), token: z.string().min(10).max(400), value: z.string().trim().min(3).max(200), code }),
]);

export const POST = route(async (request: NextRequest) => {
  if (!(await flowF18On())) throw featureNotAvailable("flow_f18");
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  enforceRateLimit(clientKey(request, "account-recover-factor"), { limit: 60, windowMs: 3_600_000 });
  switch (body.action) {
    case "start": {
      const { recoveryPerIpPerHour } = await getRule("flowsWave5");
      enforceRateLimit(clientKey(request, "account-recover-start"), { limit: recoveryPerIpPerHour, windowMs: 3_600_000 });
      return ok(await startRecovery({ lost: body.lost, contact: body.contact, ip }));
    }
    case "verify":
      return ok(await verifyRecovery({ lost: body.lost, contact: body.contact, code: body.code, taxId: body.taxId ?? null, ip }));
    case "new-code":
      return ok(await sendNewContactCode({ token: body.token, value: body.value, ip }));
    case "confirm":
      return ok(await confirmNewContact({ token: body.token, value: body.value, code: body.code, ip }));
  }
});
