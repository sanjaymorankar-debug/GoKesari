/**
 * Help desk canned replies (F6.3.3, batch-2026-10 WS-C).
 *   GET  — support (operators + admins): the active list (?all=1 includes retired).
 *   POST — admin: add one. Placeholders: {{ticketNumber}}, {{name}}, {{orderNumber}}.
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createCannedReply, listCannedReplies } from "@/server/aftercare/support-tickets";
import { cannedSchema } from "./schema";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const all = new URL(request.url).searchParams.get("all") === "1";
  return ok({ replies: await listCannedReplies(user, { includeInactive: all }) });
});

export const POST = route(async (request: NextRequest) => {
  // Allowed first: a caller who cannot manage canned replies gets 403 before the body is read (TC-RBAC-003).
  const user = await requirePermission(PERMISSIONS.SUPPORT_CANNED_REPLY_MANAGE);
  return ok(await createCannedReply(await parseBody(request, cannedSchema), user), 201);
});
