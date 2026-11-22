/**
 * POST { name, mobile, pan } — paid franchise, pay first (owner 22-Nov-2026): the smallest dealer account a buyer
 * needs before paying (a DRAFT dealer application with his PAN). He finishes KYC and bank after paying, within 30 days.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { startFranchiseBuyer } from "@/server/franchise/booking";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`franchise-buyer:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, z.object({ name: z.string().max(200), mobile: z.string().max(20), pan: z.string().max(20) }));
  const dealer = await startFranchiseBuyer({ id: user.id, role: user.role, email: user.email || null }, body);
  return ok({ dealerId: dealer.id, status: dealer.status }, 201);
});
