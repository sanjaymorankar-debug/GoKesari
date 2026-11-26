/**
 * Onboarding v2 team requests — the invited person's side (/team/invitations). 404 while onboarding_v2 is off.
 *
 * GET → my waiting requests (IST) and what my account still needs before I can accept.
 * POST {action: "accept" | "decline", invitationId} — the role is added only on accept.
 * POST {action: "claim", token} — an invite link opened after sign-in (/team/join/<token>).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { claimTeamInvitation, listMyTeamInvitations, requireOnboardingV2, respondToTeamInvitation } from "@/server/onboarding-v2/team";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["accept", "decline"]), invitationId: z.string().uuid() }),
  z.object({ action: z.literal("claim"), token: z.string().min(1).max(200) }),
]);

export const GET = route(async () => {
  await requireOnboardingV2();
  const user = await requireUser();
  return ok(await listMyTeamInvitations(user));
});

export const POST = route(async (request: NextRequest) => {
  await requireOnboardingV2();
  const user = await requireUser();
  const body = await parseBody(request, schema);
  if (body.action === "claim") return ok(await claimTeamInvitation(user, body.token));
  return ok(await respondToTeamInvitation(user, body.invitationId, body.action === "accept"));
});
