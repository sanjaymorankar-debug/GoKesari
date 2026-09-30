/**
 * Societies (GS-044). GET ?q= — verified societies to join (signed in).
 * POST — register a society; the caller becomes its first ADMIN and it waits
 * for operations to verify it (SOCIETY_REGISTER).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { requirePermission, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { registerSociety, searchSocieties } from "@/server/services/societies";

const querySchema = z.object({ q: z.string().max(80).optional() });
const schema = z.object({
  name: z.string().min(3).max(120),
  addressLine1: z.string().min(3).max(200),
  area: z.string().max(120).nullish(),
  city: z.string().min(2).max(120),
  pincode: z.string().regex(/^\d{6}$/, "PIN code must be 6 digits"),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  unitLabel: z.string().max(60).nullish(),
});

export const GET = route(async (request: NextRequest) => {
  await requireUser();
  const { q } = parseQuery(request, querySchema);
  return ok(await searchSocieties(q ?? ""));
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SOCIETY_REGISTER);
  const body = await parseBody(request, schema);
  return ok(await registerSociety(body, user), 201);
});
