/**
 * Admin preview of a template version filled with the sample shop (docs/seller-agreements-2026-11):
 * GET ?format=html|pdf. CONSENT_VIEW.
 */
import type { NextRequest } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { agreementHtmlResponse, pdfResponse } from "@/server/legal-agreements/http";
import { printHtmlToPdf } from "@/server/legal-agreements/pdf/html-to-pdf";
import { getTemplate, previewTemplateHtml } from "@/server/legal-agreements/registry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requirePermission(PERMISSIONS.CONSENT_VIEW);
  const { html } = await previewTemplateHtml(id);
  if (new URL(request.url).searchParams.get("format") === "pdf") {
    enforceRateLimit(`admin-agreement-pdf:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_READ);
    const row = await getTemplate(id);
    const pdf = await printHtmlToPdf(html, { footerNote: `${row.title} v${row.version} – SAMPLE SHOP PREVIEW` });
    return pdfResponse(pdf, `${row.docType.toLowerCase()}-v${row.version}-${row.language}-sample.pdf`);
  }
  return agreementHtmlResponse(html);
});
