/**
 * Manufacturer accounts (batch-2026-10 WS-D, F9.1.2) — PMD_MANUFACTURER_MANAGE (admin).
 * GET  → accounts with member and key counts
 * POST { name, brandNames?, contactEmail? } → a new account (its records feed source mfr_<slug>)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createManufacturerAccount, listManufacturerAccounts } from "@/server/pmd/manufacturers";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  brandNames: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  contactEmail: z.string().email().nullish(),
});

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.PMD_MANUFACTURER_MANAGE);
  return ok({ accounts: await listManufacturerAccounts() });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.PMD_MANUFACTURER_MANAGE);
  const body = await parseBody(request, schema);
  return ok(await createManufacturerAccount(body, user), 201);
});
