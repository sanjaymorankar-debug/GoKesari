/**
 * DF-09 (owner, 22-Nov-2026): POST — an admin adds a document the law requires of some shops
 * { label, labelHi?, labelMr?, lawNote, needsNumber, needsExpiry, needsAuthority }. ADMIN only, audited.
 * It is asked of no shop until it is given a rule (PUT /api/admin/shop-document-rules).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { addShopDocumentType, getDocumentRulesAdmin } from "@/server/services/shop-document-rules";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    label: z.string().min(1).max(120),
    labelHi: z.string().max(120).nullish(),
    labelMr: z.string().max(120).nullish(),
    lawNote: z.string().min(1).max(400),
    needsNumber: z.boolean(),
    needsExpiry: z.boolean(),
    needsAuthority: z.boolean(),
  })
  .strict();

export const POST = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, schema);
  const created = await addShopDocumentType(body, admin);
  return ok({ key: created.key, ...(await getDocumentRulesAdmin()) }, 201);
});
