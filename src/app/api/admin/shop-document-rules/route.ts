/**
 * Shop document rules (owner, 22-Nov-2026, DF-09): which licences and legal documents each kind of
 * shop needs — must-have before go-live, upload later on the owner's promise, or optional.
 *   GET — admin and operator.
 *   PUT { docKey, scope, level, liveShopDays?, note? } — ADMIN only, audited.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { DOCUMENT_LEVELS } from "@/lib/shop-document-rules";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { getDocumentRulesAdmin, saveDocumentRule } from "@/server/services/shop-document-rules";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireRole("ADMIN", "OPERATOR");
  return ok(await getDocumentRulesAdmin());
});

const schema = z
  .object({
    docKey: z.string().min(2).max(70),
    scope: z.string().min(3).max(70),
    level: z.enum(DOCUMENT_LEVELS),
    liveShopDays: z.number().int().min(7).max(365).nullish(),
    note: z.string().max(300).nullish(),
  })
  .strict();

export const PUT = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, schema);
  await saveDocumentRule(body, admin);
  return ok(await getDocumentRulesAdmin());
});
