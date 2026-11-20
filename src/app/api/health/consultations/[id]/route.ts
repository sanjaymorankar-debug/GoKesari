/**
 * The consultation pad. GET → consultation + patient summary (earlier records only with consent; logged).
 * POST { action: draft {...} | preview {items, suggestions} (→ PDF) | issue {items, suggestions, acknowledgeWarnings}
 *        | repeat (→ last prescription's medicines) | check {items} (→ warnings / errors) }
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { loadConsultationForDoctor, patientSummary, saveConsultationDraft } from "@/server/health/consultations";
import { bodyOf, fileResponse, ipOf, uuidParam } from "@/server/health/http";
import { checkItems, issueInput, issuePrescription, lastPrescriptionItems, previewPrescription } from "@/server/health/prescriptions";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = await uuidParam(context, "id");
  const consultation = await loadConsultationForDoctor(id, user);
  return ok({ consultation, summary: await patientSummary(id, user, ipOf(request)) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  await requireHealthEnabled();
  const id = await uuidParam(context, "id");
  const body = await bodyOf(request);
  enforceRateLimit(`health-pad:${user.id}`, RATE_LIMITS.MUTATION);
  switch (body.action) {
    case "draft":
      return ok({ consultation: await saveConsultationDraft(id, body, user) });
    case "preview": {
      const { pdf } = await previewPrescription(id, body, user);
      return fileResponse(pdf, "application/pdf", "preview.pdf");
    }
    case "check": {
      const c = await loadConsultationForDoctor(id, user);
      const input = issueInput.parse(body);
      const r = await checkItems(c, input.items);
      return ok({ errors: r.errors, warnings: r.warnings, quantities: r.resolved.map((i) => i.quantity) });
    }
    case "issue":
      return ok(await issuePrescription(id, body, user), 201);
    case "repeat":
      return ok({ items: await lastPrescriptionItems(id, user) });
    default:
      throw validationFailed("Unknown action.");
  }
});
