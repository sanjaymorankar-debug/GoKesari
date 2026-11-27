/**
 * Super franchisee administration (owner, 27-Nov-2026; docs/super-franchisee/README.md; migration 0226).
 *
 * GET ?dealerId= → the dealer as a super franchisee (rates, team, earnings), the team he is in, his history, and the
 *     lists for the admin's pickers. Admin and operator (read only).
 * POST { action, … } → ADMIN only (the services check the role again; every change needs a reason and is audited):
 *   promote {dealerId, reason, feeShareBp?, orderShareBp?} · remove {dealerId, reason}
 *   setRates {dealerId, reason, feeShareBp, orderShareBp}  (null = the rule superFranchisee's rate)
 *   assign {superDealerId, memberDealerId, reason, backdateDays?}  (also moves a dealer from another team)
 *   unassign {memberDealerId, reason}
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import {
  assignToSuperFranchisee,
  promoteSuperFranchisee,
  removeFromTeam,
  removeSuperFranchisee,
  setSuperFranchiseeRates,
  superFranchiseeView,
} from "@/server/dealers/super-franchisee";

export const dynamic = "force-dynamic";

const reason = z.string().max(500);
const bp = z.number().int().min(0).max(10_000).nullable().optional();
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("promote"), dealerId: z.string().uuid(), reason, feeShareBp: bp, orderShareBp: bp }),
  z.object({ action: z.literal("remove"), dealerId: z.string().uuid(), reason }),
  z.object({ action: z.literal("setRates"), dealerId: z.string().uuid(), reason, feeShareBp: bp, orderShareBp: bp }),
  z.object({ action: z.literal("assign"), superDealerId: z.string().uuid(), memberDealerId: z.string().uuid(), reason, backdateDays: z.number().int().min(0).max(365).nullish() }),
  z.object({ action: z.literal("unassign"), memberDealerId: z.string().uuid(), reason }),
]);

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  await requireRole("ADMIN", "OPERATOR");
  const dealerId = z.string().uuid().parse(request.nextUrl.searchParams.get("dealerId"));
  return ok({ view: await superFranchiseeView(dealerId) });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "promote":
      await promoteSuperFranchisee(body.dealerId, body, admin);
      return ok({ view: await superFranchiseeView(body.dealerId) });
    case "remove":
      await removeSuperFranchisee(body.dealerId, body.reason, admin);
      return ok({ view: await superFranchiseeView(body.dealerId) });
    case "setRates":
      await setSuperFranchiseeRates(body.dealerId, body, admin);
      return ok({ view: await superFranchiseeView(body.dealerId) });
    case "assign":
      await assignToSuperFranchisee(body.superDealerId, body.memberDealerId, body, admin);
      return ok({ view: await superFranchiseeView(body.superDealerId) });
    case "unassign":
      await removeFromTeam(body.memberDealerId, body.reason, admin);
      return ok({ view: await superFranchiseeView(body.memberDealerId) });
  }
});
