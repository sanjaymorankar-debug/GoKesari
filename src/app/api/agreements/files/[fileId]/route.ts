/**
 * A signed agreement PDF (docs/seller-agreements-2026-11): for the shop's owner, staff who may view the consent
 * record (CONSENT_VIEW), or anyone holding the signed, expiring link from the signed-copy e-mail
 * (?exp=…&sig=…). The file's SHA-256 is checked against the record before it is sent.
 */
import type { NextRequest } from "next/server";

import { forbidden } from "@/lib/errors";
import { route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { readSignedFile } from "@/server/legal-agreements/admin";
import { checkFileLink } from "@/server/legal-agreements/email";
import { clientIp, pdfResponse } from "@/server/legal-agreements/http";
import { and, eq, isNull } from "drizzle-orm";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ fileId: string }>) => {
  const { fileId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw forbidden("Not available.");
  const url = new URL(request.url);
  enforceRateLimit(`agreement-file:${clientIp(request) ?? "?"}`, RATE_LIMITS.SELLER_DOCUMENT_READ);
  if (checkFileLink(fileId, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    const file = await readSignedFile(fileId, { staff: true });
    return pdfResponse(file.data, file.filename);
  }
  const user = await getCurrentUser();
  if (!user) throw forbidden("Sign in to download your agreements.");
  const owned = await db.select({ id: shops.id }).from(shops).where(and(eq(shops.ownerId, user.id), isNull(shops.deletedAt)));
  const file = await readSignedFile(fileId, { shopIds: owned.map((s) => s.id), staff: can(user.role, PERMISSIONS.CONSENT_VIEW) });
  return pdfResponse(file.data, file.filename, url.searchParams.get("inline") === "1");
});
