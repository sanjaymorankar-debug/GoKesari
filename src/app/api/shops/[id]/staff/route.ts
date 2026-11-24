/**
 * The people who work in this shop (Module 1; roles: Module 10, docs/shop-staff-roles-2026-11).
 *   GET  → current, invited, paused and past staff (contact masked), with role and permissions.
 *   POST { identifier } — flag shop_staff_roles_enabled OFF (as before): adds an existing
 *        GoKesari account at once as catalogue staff (photos and descriptions). Owner only
 *        (operators/admins for support).
 *   POST { identifier, role, permissions? } — flag ON: invites the person with a role; nothing
 *        is granted until they accept. The owner, or a staff manager (staff.create) within
 *        their own permissions.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SHOP_STAFF_ROLES } from "@/lib/shop-staff/permissions";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess, requireUser } from "@/server/authz/guards";
import { requireShopPermission } from "@/server/authz/shop-permission";
import { PERMISSIONS } from "@/server/authz/permissions";
import { addShopStaff, inviteShopStaff, listShopStaff } from "@/server/services/shop-staff";
import { shopStaffRolesEnabled } from "@/server/services/shop-staff-access";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const user = await requireUser();
  return ok({ staff: await listShopStaff(id, user) });
});

const legacySchema = z.object({ identifier: z.string().trim().min(5).max(200) });
const inviteSchema = z.object({
  identifier: z.string().trim().min(5).max(200),
  role: z.enum(SHOP_STAFF_ROLES).default("CATALOGUE_MANAGER"),
  permissions: z.array(z.string().max(60)).max(80).optional(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const user = await requireUser();
  enforceRateLimit(`shop-staff-add:${user.id}`, { limit: 20, windowMs: 60 * 60_000 });
  if (await shopStaffRolesEnabled()) {
    // Owner, operations, or this shop's staff manager: anyone else gets 403 before the body is read.
    await requireShopPermission(id, "staff.create", { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
    const body = await parseBody(request, inviteSchema);
    return ok(await inviteShopStaff(id, body, user), 201);
  }
  // The shop's owner or operations first: another shop's owner gets 403 before the body is read (TC-RBAC-005).
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  const { identifier } = await parseBody(request, legacySchema);
  return ok(await addShopStaff(id, identifier, user), 201);
});
