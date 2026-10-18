/** GET — search / filter / sort products across staging and master (staff, PMD_VIEW) (batch-2026-10 WS-D, F9.1.4). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { searchBrowser } from "@/server/pmd/browser";

export const dynamic = "force-dynamic";

const browserQuerySchema = z.object({
  scope: z.enum(["staging", "master", "all"]).optional(),
  q: z.string().max(200).optional(),
  brand: z.string().max(120).optional(),
  category: z.string().max(200).optional(),
  source: z.string().max(80).optional(),
  missingHsn: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  minQuality: z.coerce.number().min(0).max(100).optional(),
  sort: z.enum(["name", "quality", "updated", "gtin"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  return ok(await searchBrowser(parseQuery(request, browserQuerySchema)));
});
