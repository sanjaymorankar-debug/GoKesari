/**
 * docs/dealer-platform phase 4: one scheme (id = scheme id).
 *   POST { action: "saveDraft", versionId?, terms, label?, reason }
 *        { action: "publish", versionId, effectiveFrom?, reason }      — now, or scheduled
 *        { action: "status", to: SUSPENDED | PUBLISHED | EXPIRED | ARCHIVED, reason }
 *        { action: "deleteDraft", versionId, reason }
 *        { action: "compare", a, b }                                    — field-by-field differences
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { dealerFourEyeOn, requestDealerApproval } from "@/server/approvals";
import { compareVersions, deleteDraft, publishVersion, requireSchemePermission, saveDraft, setSchemeStatus } from "@/server/dealers/scheme-admin";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("saveDraft"), versionId: z.string().uuid().nullish(), terms: z.unknown(), label: z.string().max(80).nullish(), reason: z.string().max(500) }),
  z.object({ action: z.literal("publish"), versionId: z.string().uuid(), effectiveFrom: z.string().datetime({ offset: true }).nullish(), reason: z.string().max(500) }),
  z.object({ action: z.literal("status"), to: z.enum(["SUSPENDED", "PUBLISHED", "EXPIRED", "ARCHIVED"]), reason: z.string().max(500) }),
  z.object({ action: z.literal("deleteDraft"), versionId: z.string().uuid(), reason: z.string().max(500) }),
  z.object({ action: z.literal("compare"), a: z.string().uuid(), b: z.string().uuid() }),
]);

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  enforceRateLimit(`dealer-scheme:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, Body);
  switch (body.action) {
    case "saveDraft":
      return ok({ version: await saveDraft(user, id, { versionId: body.versionId, terms: body.terms, label: body.label, reason: body.reason }) });
    case "publish":
      // Phase 6: with dealer_platform_four_eye on, a second admin approves (the permission is checked now too).
      await requireSchemePermission(user, "SCHEME_PUBLISH");
      if (await dealerFourEyeOn()) {
        return ok(await requestDealerApproval({ type: "DEALER_SCHEME_PUBLISH", actor: user, subjectType: "dealer_scheme", subjectId: id, title: "Publish a dealer scheme version", reason: body.reason, payload: { versionId: body.versionId, effectiveFrom: body.effectiveFrom ?? null } }), 202);
      }
      return ok({ version: await publishVersion(user, body.versionId, { effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null, reason: body.reason }) });
    case "status":
      await requireSchemePermission(user, "SCHEME_STATUS");
      if (await dealerFourEyeOn()) {
        return ok(await requestDealerApproval({ type: "DEALER_SCHEME_STATUS", actor: user, subjectType: "dealer_scheme", subjectId: id, title: `Dealer scheme → ${body.to.toLowerCase()}`, reason: body.reason, payload: { schemeId: id, to: body.to } }), 202);
      }
      return ok({ scheme: await setSchemeStatus(user, id, body.to, body.reason) });
    case "deleteDraft":
      await deleteDraft(user, body.versionId, body.reason);
      return ok({ deleted: true });
    case "compare":
      if (user.role !== "ADMIN" && user.role !== "OPERATOR") throw forbidden();
      return ok(await compareVersions(body.a, body.b));
  }
});
