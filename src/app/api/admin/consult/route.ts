/**
 * Consultant appointments for staff (consult:manage — admins and operators).
 * GET ?view=categories | templates | profiles&verification&q | bookings&status&from&to&q&shopId&refunds&disputes
 *     | report&from&to | documents&member
 * POST { action, … }: category {…} · template {…} · verify {profileId, decision, note?, members[]} · cancel {bookingId, reason}
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { consultReport, listAllBookings, listCategories, listProfiles, listTemplates, saveCategory, saveTemplate, verifyProfile } from "@/server/consult/admin";
import { staffCancel } from "@/server/consult/bookings";
import { memberDocumentLinks } from "@/server/consult/files";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.CONSULT_MANAGE);
  const q = Object.fromEntries(request.nextUrl.searchParams.entries());
  switch (q.view ?? "profiles") {
    case "categories":
      return ok({ categories: await listCategories(user) });
    case "templates":
      return ok({ templates: await listTemplates(user) });
    case "profiles":
      return ok({ profiles: await listProfiles(user, { verification: q.verification, q: q.q }) });
    case "bookings":
      return ok({ bookings: await listAllBookings(user, q) });
    case "report":
      return ok(await consultReport(user, q.from, q.to));
    case "documents":
      return ok({ documents: await memberDocumentLinks(z.string().uuid().parse(q.member), user) });
    default:
      throw validationFailed("Unknown view.");
  }
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.CONSULT_MANAGE);
  enforceRateLimit(`consult-admin:${user.id}`, RATE_LIMITS.MUTATION);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  switch (body.action) {
    case "category":
      return ok({ category: await saveCategory(body.category ?? {}, user) });
    case "template":
      return ok({ template: await saveTemplate(body.template ?? {}, user) });
    case "verify":
      return ok({ profile: await verifyProfile(z.string().uuid().parse(body.profileId), body, user) });
    case "cancel":
      return ok({ booking: await staffCancel(z.string().uuid().parse(body.bookingId), user, String(body.reason ?? "")) });
    default:
      throw validationFailed("Unknown action.");
  }
});
