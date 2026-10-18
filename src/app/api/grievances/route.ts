/**
 * Grievance redressal (Part 58 — IT Rules 2021 Rule 3(2)).
 *
 * POST is deliberately public — no permission check — because a complaint
 * about being unable to sign in must not itself require signing in. GET is
 * admin/operator only: it lists ALL grievances, which is not something an
 * anonymous complainant should be able to browse. Public status lookup for a
 * single ticket lives at GET /api/grievances/lookup (email-gated).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser, requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getGrievanceDashboard, listGrievances, submitGrievance } from "@/server/services/grievances";
import { mirrorGrievanceToTicket } from "@/server/aftercare/support-tickets"; // batch-2026-10 WS-C

export const dynamic = "force-dynamic";

const submitSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().max(20).nullish(),
  category: z.enum([
    "PAYMENT",
    "WALLET",
    "ORDER",
    "SUBSCRIPTION",
    "SELLER",
    "PRODUCT",
    "PRIVACY",
    "OTHER",
  ]),
  subject: z.string().min(3).max(200),
  description: z.string().min(10).max(4000),
});

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "grievance"), RATE_LIMITS.GRIEVANCE);
  const body = await parseBody(request, submitSchema);
  const user = await getCurrentUser();
  const grievance = await submitGrievance({ ...body, submittedByUserId: user?.id ?? null });
  // batch-2026-10 WS-C (F6.3.3): the complaint also opens a linked help desk
  // ticket (rule helpdesk.ticketForGrievances). Never fails the submission.
  await mirrorGrievanceToTicket(grievance);
  return ok(
    { ticketNumber: grievance.ticketNumber, status: grievance.status, createdAt: grievance.createdAt },
    201,
  );
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.GRIEVANCE_MANAGE);
  const p = new URL(request.url).searchParams;
  if (p.get("dashboard") === "1") {
    return ok(await getGrievanceDashboard());
  }
  const grievances = await listGrievances({
    status: (p.get("status") as never) ?? undefined,
    category: (p.get("category") as never) ?? undefined,
    search: p.get("q") ?? undefined,
  });
  return ok({ grievances });
});
