/**
 * POST { masterProductIds: [...], note?, images? } — the Promote button, single or bulk (batch-2026-10 WS-D, F9.1.4).
 * Moves reviewed staging records into the marketplace catalogue (available to every shop) through the
 * audited catalogue bridge, one transaction per product. PMD_PROMOTE.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { guardedWsd } from "@/server/pmd/api-access";
import { promoteMany } from "@/server/pmd/browser";

export const dynamic = "force-dynamic";

const schema = z.object({
  masterProductIds: z.array(z.string().regex(/^GKS-PROD-\d{9}$/)).min(1).max(500),
  note: z.string().max(300).nullish(),
  images: z.boolean().optional(),
  minQuality: z.number().min(0).max(100).optional(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PMD_PROMOTE);
  const body = await parseBody(request, schema);
  return ok(await guardedWsd(() => promoteMany(body.masterProductIds, user, { note: body.note, images: body.images, minQuality: body.minQuality })));
});
