/**
 * DF-09: PATCH — changes an admin-added document (names, law, what the form asks for) or switches it
 * off / on { status }. ADMIN only, audited. The key never changes; what shops uploaded stays.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { getDocumentRulesAdmin, updateShopDocumentType } from "@/server/services/shop-document-rules";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    labelHi: z.string().max(120).nullish(),
    labelMr: z.string().max(120).nullish(),
    lawNote: z.string().min(1).max(400).optional(),
    needsNumber: z.boolean().optional(),
    needsExpiry: z.boolean().optional(),
    needsAuthority: z.boolean().optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .strict();

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ key: string }>) => {
  const admin = await requireRole("ADMIN");
  const { key } = await context.params;
  const body = await parseBody(request, schema);
  await updateShopDocumentType(decodeURIComponent(key), body, admin);
  return ok(await getDocumentRulesAdmin());
});
