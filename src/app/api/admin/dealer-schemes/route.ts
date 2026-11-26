/**
 * docs/dealer-platform phase 4: Admin → Dealers → Schemes.
 *   GET  → every scheme with its versions (admins and operators read)
 *   POST { code, name, category, cloneFromVersionId?, reason } → a new scheme with a draft version 1
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SCHEME_CATEGORIES } from "@/lib/dealer-schemes";
import { forbidden } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { createScheme, schemePermissions } from "@/server/dealers/scheme-admin";
import { listSchemes } from "@/server/dealers/schemes";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") throw forbidden();
  return ok({ schemes: await listSchemes() });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  // D-170: staff only — answered before the request body is read.
  const allowed = await schemePermissions(user);
  if (!allowed.edit && !allowed.publish) throw forbidden();
  enforceRateLimit(`dealer-schemes:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(
    request,
    z.object({ code: z.string().min(2).max(40), name: z.string().min(3).max(80), category: z.enum(SCHEME_CATEGORIES), cloneFromVersionId: z.string().uuid().nullish(), reason: z.string().max(500) }),
  );
  return ok(await createScheme(user, body), 201);
});
