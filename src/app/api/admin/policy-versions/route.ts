/**
 * Policy versions (docs/policy-reconsent-2026-11).
 *
 * GET  → acceptance counts per document and version (CONSENT_VIEW).
 * POST → publish a new version (administrators only; audited).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission, requireRole } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { POLICY_DOCS } from "@/server/db/schema";
import { getPolicyAcceptanceReport, publishPolicyVersion } from "@/server/services/policy-versions";

const schema = z.object({
  doc: z.enum(POLICY_DOCS),
  version: z.string().min(1).max(40),
  summary: z.object({
    en: z.string().min(1).max(2000),
    hi: z.string().max(2000).optional(),
    mr: z.string().max(2000).optional(),
  }),
  requiresAcceptance: z.boolean(),
  reason: z.string().min(1).max(500),
});

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.CONSENT_VIEW);
  return ok({ documents: await getPolicyAcceptanceReport() });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  const body = await parseBody(request, schema);
  const row = await publishPolicyVersion(user, body);
  return ok({ version: row }, 201);
});
