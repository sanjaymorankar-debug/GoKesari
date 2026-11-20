/** Record views: ?view=timeline|providers|medicines|documents|prescriptions|suggestions (&kind, &q). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { DOCUMENT_KINDS, TIMELINE_KINDS, type DocumentKind, type TimelineKind } from "@/lib/health/constants";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { uuidParam } from "@/server/health/http";
import { patientPrescriptions } from "@/server/health/prescriptions";
import { patientSuggestions, recordByProvider, recordDocuments, recordMedicines, recordTimeline } from "@/server/health/records";

export const dynamic = "force-dynamic";

const q = z.object({
  view: z.enum(["timeline", "providers", "medicines", "documents", "prescriptions", "suggestions"]).default("timeline"),
  kind: z.string().max(40).nullish(),
  q: z.string().max(80).nullish(),
});

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = await uuidParam(context, "id");
  const params = q.parse(Object.fromEntries(request.nextUrl.searchParams));
  const kind = params.kind ?? "";
  switch (params.view) {
    case "providers":
      return ok({ providers: await recordByProvider(id, user) });
    case "medicines":
      return ok({ medicines: await recordMedicines(id, user) });
    case "documents":
      return ok({ documents: await recordDocuments(id, user, (DOCUMENT_KINDS as readonly string[]).includes(kind) ? (kind as DocumentKind) : null) });
    case "prescriptions":
      return ok({ prescriptions: await patientPrescriptions(id, user) });
    case "suggestions":
      return ok({ suggestions: await patientSuggestions(id, user) });
    default:
      return ok({ timeline: await recordTimeline(id, user, { kind: (TIMELINE_KINDS as readonly string[]).includes(kind) ? (kind as TimelineKind) : null, q: params.q ?? null }) });
  }
});
