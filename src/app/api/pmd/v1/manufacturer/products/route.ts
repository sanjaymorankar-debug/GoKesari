/**
 * Manufacturer bulk upload by API key (batch-2026-10 WS-D, F9.1.2).
 *
 *   POST /api/pmd/v1/manufacturer/products
 *   Authorization: Bearer gkm_…            (issued at /manufacturer/keys; shown once; revocable)
 *   Content-Type: application/json         { "products": [ { "gtin": "8901058000001", "name": "…", "brand": "…", "mrp": "62.00", … } ] }
 *              or text/csv                  the template's columns
 *
 * 202 with the import job (validated and staged; loaded in batches — poll
 * GET /api/pmd/v1/manufacturer/jobs/{id}). 401 for a missing, unknown or
 * revoked key; 429 over the per-key rate limit (rule pmdSources.apiRequestsPerMinute).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { guardedWsd } from "@/server/pmd/api-access";
import { createManufacturerJob } from "@/server/pmd/ingest-jobs";
import { authenticateManufacturerApiKey } from "@/server/pmd/manufacturers";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

const jsonSchema = z.object({
  fileName: z.string().max(200).optional(),
  products: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).min(1).max(10_000),
});

export const POST = route(async (request: NextRequest) => {
  const session = await authenticateManufacturerApiKey(request);
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const result = await guardedWsd(async () => {
    if (type === "text/csv") {
      const text = await request.text();
      if (!text.trim()) throw validationFailed("The CSV body is empty.");
      return createManufacturerJob({ accountId: session.account.id, via: "API", fileName: "api-upload.csv", file: Buffer.from(text, "utf8") }, { id: null, role: null });
    }
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw validationFailed("Send JSON { products: [...] } or text/csv.");
    }
    const body = jsonSchema.parse(raw);
    return createManufacturerJob(
      { accountId: session.account.id, via: "API", fileName: body.fileName ?? "api-upload.json", rows: body.products },
      { id: null, role: null },
    );
  });
  await recordAudit({
    action: AUDIT_ACTIONS.PMD_API_KEY_USED,
    entityType: "pmd_manufacturer",
    entityId: session.account.id,
    newValue: { keyId: session.keyId, jobId: result.job.id, rows: result.job.totalRows, valid: result.job.validRows },
  });
  return ok({ job: result.job }, 202);
});
