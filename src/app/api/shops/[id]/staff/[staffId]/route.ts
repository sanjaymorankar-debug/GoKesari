/**
 * One staff member of a shop (Module 1; Module 10 docs/shop-staff-roles-2026-11).
 *   DELETE                         remove their access (or cancel an open invitation).
 *   PATCH { role, permissions? }   change their role (flag shop_staff_roles_enabled).
 *   PATCH { suspended: boolean }   pause or restore their access (flag).
 * The owner, operations, or (flag on) a staff manager within their own permissions.
 * Every change is audited and takes effect on the person's next request.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SHOP_STAFF_ROLES } from "@/lib/shop-staff/permissions";
import { noContent, ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { changeShopStaffRole, removeShopStaff, setShopStaffSuspended } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), staffId: z.string().uuid() });

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string; staffId: string }>) => {
  const { id, staffId } = ids.parse(await context.params);
  const user = await requireUser();
  enforceRateLimit(`shop-staff:${user.id}`, RATE_LIMITS.MUTATION);
  await removeShopStaff(id, staffId, user);
  return noContent();
});

const patchSchema = z.union([
  z.object({ suspended: z.boolean() }).strict(),
  z.object({ role: z.enum(SHOP_STAFF_ROLES), permissions: z.array(z.string().max(60)).max(80).optional() }).strict(),
]);

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string; staffId: string }>) => {
  const { id, staffId } = ids.parse(await context.params);
  const user = await requireUser();
  enforceRateLimit(`shop-staff:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, patchSchema);
  if ("suspended" in body) await setShopStaffSuspended(id, staffId, body.suspended, user);
  else await changeShopStaffRole(id, staffId, body, user);
  return ok({ saved: true });
});
