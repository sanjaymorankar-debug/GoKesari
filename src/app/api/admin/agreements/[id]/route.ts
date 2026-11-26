/**
 * One agreement template version (docs/seller-agreements-2026-11).
 *   GET    → the version with its body and the publishing checks (blocking problems, warnings). CONSENT_VIEW.
 *   PATCH  → edit a draft (ADMIN): effectiveDate, title, templateBody, appliesToShopTypes, sourceValues, changeSummary, requiresResign
 *   POST   { action: "review", what: "translation" | <review note key> } → confirm a lawyer's review (ADMIN)
 *          { action: "publish", acknowledgeWarnings } → publish (ADMIN); blocked by any blocking check
 *          { action: "retire" } → retire (ADMIN)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission, requireRole } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { templateInput } from "@/server/legal-agreements/http";
import { confirmReview, getTemplate, publishChecks, publishTemplate, retireTemplate, updateDraft } from "@/server/legal-agreements/registry";
import { templateTokens } from "@/server/legal-agreements/template-engine";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requirePermission(PERMISSIONS.CONSENT_VIEW);
  const row = await getTemplate(id);
  let tokens: ReturnType<typeof templateTokens> | null = null;
  try {
    tokens = templateTokens(row.templateBody);
  } catch {
    tokens = null;
  }
  return ok({ template: row, tokens, checks: row.status === "DRAFT" ? await publishChecks(id) : null });
});

const patch = templateInput.pick({ effectiveDate: true, title: true, templateBody: true, appliesToShopTypes: true, sourceValues: true, changeSummary: true, requiresResign: true }).partial();

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireRole("ADMIN");
  enforceRateLimit(`admin-agreements:${user.id}`, RATE_LIMITS.MUTATION);
  return ok(await updateDraft(id, await parseBody(request, patch), user));
});

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), what: z.string().trim().min(1).max(60) }),
  z.object({ action: z.literal("publish"), acknowledgeWarnings: z.boolean().default(false) }),
  z.object({ action: z.literal("retire") }),
]);

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireRole("ADMIN");
  enforceRateLimit(`admin-agreements:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, action);
  switch (body.action) {
    case "review":
      return ok(await confirmReview(id, body.what, user));
    case "publish":
      return ok(await publishTemplate(id, user, { acknowledgeWarnings: body.acknowledgeWarnings }));
    case "retire":
      return ok(await retireTemplate(id, user));
    default:
      throw validationFailed("Unknown action.");
  }
});
