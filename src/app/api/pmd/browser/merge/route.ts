/**
 * Duplicates (batch-2026-10 WS-D, F9.1.4) — PMD_REVIEW.
 * GET                              → open possible-duplicate pairs, side by side
 * GET ?a=GKS-PROD-…&b=GKS-PROD-…   → any two records side by side
 * POST { fromMasterId, intoMasterId, reason } → merge (pointer + merge log, existing review merge)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { guardedWsd } from "@/server/pmd/api-access";
import { compareProducts, listDuplicatePairs, mergeDuplicate } from "@/server/pmd/browser";

export const dynamic = "force-dynamic";

const id = z.string().regex(/^GKS-PROD-\d{9}$/);

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PMD_REVIEW);
  const p = new URL(request.url).searchParams;
  if (p.get("a") && p.get("b")) return ok(await guardedWsd(() => compareProducts(id.parse(p.get("a")), id.parse(p.get("b")))));
  return ok({ pairs: await listDuplicatePairs() });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PMD_REVIEW);
  const body = await parseBody(request, z.object({ fromMasterId: id, intoMasterId: id, reason: z.string().max(300).nullish() }));
  return ok(await guardedWsd(() => mergeDuplicate(body, user)));
});
