/**
 * Onboarding v2 "My team" (docs/onboarding-v2-2026-11, Flow 4) — the dealer's (or a team lead's) side.
 * 404 while the onboarding_v2 flag (or the dealer programme) is off; the existing /api/dealer/team is unchanged.
 *
 * GET → teamOverview: members with role, lead, code and what stops their first payout; leads; requests; role history (IST).
 * POST { action, … }:
 *   search {query}                          exact mobile / e-mail search, masked name only
 *   invite {contact, role, parentId?}       request (registered customer) or invite link (anyone else)
 *   cancel {invitationId}
 *   upgrade {memberId}                      agent → team lead (dealer only)
 *   downgrade {memberId, parentId?}         team lead → agent, once his agents are reassigned (dealer only)
 *   reassign {memberId, parentId}           agent under another lead or the dealer (parentId null; dealer only)
 *   remove {memberId}                       back to customer only (dealer only)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { originOf, requireDealerProgramme } from "@/server/dealers/http";
import {
  cancelTeamInvitation,
  downgradeToAgent,
  inviteTeamMember,
  reassignAgent,
  removeTeamRole,
  requireOnboardingV2,
  searchTeamCandidate,
  teamOverview,
  upgradeToTeamLead,
} from "@/server/onboarding-v2/team";

export const dynamic = "force-dynamic";

const role = z.enum(["TEAM_LEAD", "AGENT"]);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search"), query: z.string().min(1).max(254) }),
  z.object({ action: z.literal("invite"), contact: z.string().min(1).max(254), role, parentId: z.string().uuid().nullish() }),
  z.object({ action: z.literal("cancel"), invitationId: z.string().uuid() }),
  z.object({ action: z.literal("upgrade"), memberId: z.string().uuid() }),
  z.object({ action: z.literal("downgrade"), memberId: z.string().uuid(), parentId: z.string().uuid().nullish() }),
  z.object({ action: z.literal("reassign"), memberId: z.string().uuid(), parentId: z.string().uuid().nullable() }),
  z.object({ action: z.literal("remove"), memberId: z.string().uuid() }),
]);

async function guard() {
  await requireOnboardingV2();
  await requireDealerProgramme();
  return requireUser();
}

export const GET = route(async () => {
  const user = await guard();
  return ok(await teamOverview(user));
});

export const POST = route(async (request: NextRequest) => {
  const user = await guard();
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "search":
      return ok(await searchTeamCandidate(user, body.query));
    case "invite":
      return ok(await inviteTeamMember(user, { contact: body.contact, role: body.role, parentId: body.parentId ?? null, origin: originOf(request) }), 201);
    case "cancel":
      await cancelTeamInvitation(user, body.invitationId);
      return ok({ cancelled: true });
    case "upgrade":
      return ok({ member: { id: (await upgradeToTeamLead(user, body.memberId)).id } });
    case "downgrade":
      return ok({ member: { id: (await downgradeToAgent(user, body.memberId, { parentId: body.parentId ?? null })).id } });
    case "reassign":
      return ok({ member: { id: (await reassignAgent(user, body.memberId, { parentId: body.parentId })).id } });
    case "remove":
      await removeTeamRole(user, body.memberId);
      return ok({ removed: true });
  }
});
