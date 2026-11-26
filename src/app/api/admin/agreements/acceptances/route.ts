/**
 * The acceptance record (docs/seller-agreements-2026-11, brief §6). CONSENT_VIEW (admins and operators).
 *   GET ?shop=&docType=&version=&from=YYYY-MM-DD&to=YYYY-MM-DD&offset=&format=csv
 *   GET ?emails=<signingRequestId>     → the e-mail send log of one signing
 *   POST { action: "resend", signingRequestId, includeBanners? } → queue the signed copy again
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { acceptancesCsv, listAcceptances } from "@/server/legal-agreements/admin";
import { emailLogFor, resendSignedCopy } from "@/server/legal-agreements/email";

export const dynamic = "force-dynamic";

const query = z.object({
  shop: z.string().trim().max(100).optional(),
  docType: z.enum(["SELLER_SLA", "MEDICAL_ONBOARDING"]).optional(),
  version: z.string().trim().max(10).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  format: z.enum(["json", "csv"]).default("json"),
  emails: z.string().uuid().optional(),
});

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.CONSENT_VIEW);
  const q = parseQuery(request, query);
  if (q.emails) return ok({ emails: await emailLogFor(q.emails) });
  if (q.format === "csv") {
    await recordAudit({ actorId: user.id, actorRole: user.role, action: AUDIT_ACTIONS.CONSENT_HISTORY_VIEWED, entityType: "legal_acceptances", newValue: { export: "csv", filter: { ...q, format: undefined } } });
    const csv = await acceptancesCsv(q);
    return new NextResponse(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="agreement-acceptances.csv"`, "Cache-Control": "no-store" },
    });
  }
  return ok(await listAcceptances({ ...q, limit: 50 }));
});

const resend = z.object({ action: z.literal("resend"), signingRequestId: z.string().uuid(), includeBanners: z.boolean().default(false) });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.CONSENT_VIEW);
  enforceRateLimit(`agreement-resend:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, resend);
  return ok({ emailId: await resendSignedCopy(body.signingRequestId, user, body.includeBanners) });
});
