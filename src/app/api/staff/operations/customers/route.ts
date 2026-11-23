/**
 * RBAC v2 Phase 6: customers an Operations User is helping to register.
 *   GET    ?open=1            own assists (Operations Manager: everyone's)
 *   POST   record an enquiry  Operations User (CUSTOMER_ONBOARD_ASSIST)
 *   PATCH  ?id=  { status: ENQUIRY | INVITED | DROPPED, notes, followUpAt }
 * The customer signs up with GoKesari's normal e-mailed sign-in code themselves; the assist is
 * linked to that account automatically (src/server/rbac-operations/assists.ts).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { createCustomerAssist, listCustomerAssists, updateCustomerAssist } from "@/server/rbac-operations";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const actor = await requireUser();
  const { open } = parseQuery(request, z.object({ open: z.enum(["0", "1"]).optional() }));
  return ok(await listCustomerAssists(actor, { open: open === "1" }));
});

const create = z.object({
  customerName: z.string().trim().min(2).max(120),
  contactEmail: z.string().trim().max(200).nullish(),
  contactPhone: z.string().trim().max(20).nullish(),
  pincode: z.string().trim().max(6).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  followUpAt: z.coerce.date().nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireUser();
  return ok(await createCustomerAssist(actor, await parseBody(request, create)), 201);
});

const patch = z.object({
  status: z.enum(["ENQUIRY", "INVITED", "DROPPED"]).optional(),
  notes: z.string().trim().max(2000).nullish(),
  followUpAt: z.coerce.date().nullish(),
});

export const PATCH = route(async (request: NextRequest) => {
  const actor = await requireUser();
  const { id } = parseQuery(request, z.object({ id: z.string().uuid() }));
  return ok(await updateCustomerAssist(actor, id, await parseBody(request, patch)));
});
