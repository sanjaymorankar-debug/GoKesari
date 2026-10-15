/** Bulk product upload (docs/product-import-2026-10): the admin / operator shop picker. ?q= shop name or city. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { searchShopsForImport } from "@/server/services/product-import";

export const dynamic = "force-dynamic";

const query = z.object({ q: z.string().max(100).default("") });

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.EXCEL_UPLOAD_ANY);
  const { q } = parseQuery(request, query);
  return ok({ shops: await searchShopsForImport(q) });
});
