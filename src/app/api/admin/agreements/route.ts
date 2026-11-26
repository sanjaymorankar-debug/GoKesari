/**
 * Agreement templates (docs/seller-agreements-2026-11, Admin → Agreements).
 *   GET   → every version (draft / published / retired, by language), the pending counts and the settings.
 *           Imports the bundled v1.0 templates on first use. CONSENT_VIEW (admins and operators).
 *   POST  → upload a new version (ADMIN): { docType, language, version, effectiveDate, templateBody, title?,
 *           appliesToShopTypes?, sourceValues?, changeSummary?, requiresResign? }
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission, requireRole } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { pendingCounts } from "@/server/legal-agreements/admin";
import { templateInput } from "@/server/legal-agreements/http";
import { createTemplateVersion, ensureBundledTemplates, listTemplates } from "@/server/legal-agreements/registry";
import { getRule } from "@/server/services/settings";
import { getFeatureFlag } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.CONSENT_VIEW);
  if (user.role === "ADMIN") await ensureBundledTemplates(user.id);
  const [templates, pending, settings, flag] = await Promise.all([listTemplates(), pendingCounts(), getRule("sellerAgreements"), getFeatureFlag("seller_agreements_enabled")]);
  return ok({
    canEdit: user.role === "ADMIN",
    flagEnabled: flag.enabled,
    templates: templates.map(({ templateBody, ...t }) => ({ ...t, bodyLength: templateBody.length })),
    pending,
    settings,
  });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  enforceRateLimit(`admin-agreements:${user.id}`, RATE_LIMITS.MUTATION);
  const input = await parseBody(request, templateInput);
  return ok(await createTemplateVersion(input, user), 201);
});
