/**
 * Manufacturer portal uploads (batch-2026-10 WS-D, F9.1.2) — signed-in member of a manufacturer account.
 * GET              → the account's imports with progress
 * POST multipart   → file (template .csv / .xlsx) → validated, staged import job (202)
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { guardedWsd, readUploadedFile } from "@/server/pmd/api-access";
import { createManufacturerJob, listJobs } from "@/server/pmd/ingest-jobs";
import { requireManufacturerMembership } from "@/server/pmd/manufacturers";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const account = await requireManufacturerMembership(user.id, new URL(request.url).searchParams.get("account"));
  return ok({ account: { id: account.id, name: account.name }, jobs: await listJobs({ manufacturerAccountId: account.id }) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(clientKey(request, `pmd-upload:${user.id}`), RATE_LIMITS.SELLER_DOCUMENT_UPLOAD);
  const account = await requireManufacturerMembership(user.id, new URL(request.url).searchParams.get("account"));
  const { bytes, fileName } = await readUploadedFile(request);
  const result = await guardedWsd(() => createManufacturerJob({ accountId: account.id, via: "PORTAL", fileName, file: bytes }, user));
  return ok(result, 202);
});
