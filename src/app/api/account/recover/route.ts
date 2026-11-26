/**
 * Account recovery request (docs/flows-v3/wave1.md; flag flow_f17 — 404 while it is off).
 *
 * POST multipart/form-data: name, contactEmail, contactPhone?, oldMobile?, oldEmail?, description, idProof (photo
 * or PDF). Public (the person cannot sign in), limited per address (rule supportFlows.recoveryPerIpPerHour).
 * Opens an ACCOUNT ticket for support; answers with the ticket number only.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { submitRecoveryRequest } from "@/server/aftercare/account-recovery";
import { flowF17On } from "@/server/aftercare/support-tickets";
import { featureNotAvailable } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

export const POST = route(async (request: NextRequest) => {
  if (!(await flowF17On())) throw featureNotAvailable("flow_f17");
  const { recoveryPerIpPerHour } = await getRule("supportFlows");
  enforceRateLimit(clientKey(request, "account-recover"), { limit: recoveryPerIpPerHour, windowMs: 3_600_000 });
  const form = await request.formData().catch(() => null);
  if (!form) throw validationFailed("Send the form with its file.");
  const file = form.get("idProof");
  if (!(file instanceof File)) throw validationFailed("Please check the highlighted fields.", { fields: { idProof: "Attach a photo or PDF of an identity document." } });
  const result = await submitRecoveryRequest(
    {
      name: text(form, "name"),
      contactEmail: text(form, "contactEmail"),
      contactPhone: text(form, "contactPhone"),
      oldMobile: text(form, "oldMobile"),
      oldEmail: text(form, "oldEmail"),
      description: text(form, "description"),
    },
    { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) },
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
  );
  return ok(result, 201);
});
