/**
 * TIERED dealer commission administration (docs/dealer-programme/TIERED_COMMISSION.md).
 *
 * GET ?dealerId= → the rule (dealerTieredCommission, dealerPayoutTds), the dealer's team tree,
 *     earnings by type and level, TRADING progress, and the open sub-agent requests. Admin and operator (read only).
 * POST { action, … } → ADMIN only (the services check the role again):
 *   setModel {dealerId, model: STANDARD|TIERED, reason} · setRates {dealerId, directBp, leadOverrideBp, mainOverrideBp, reason}
 *   addMember {dealerId, employeeId, name, mobile?, role, parentId?} · placeMember {memberId, role, parentId, reason}
 *   promote {memberId, reason, override?} · decideRequest {requestId, approve, note?}
 *   payee {memberId, pan?, bankHolderName?, bankAccount?, ifsc?} · verifyBank {memberId, verified, reason}
 *   linkAccount {memberId, email}
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { TEAM_ROLES } from "@/lib/dealer-tiers";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { addSalesperson } from "@/server/dealers/service";
import {
  decideTeamRequest,
  earningsByType,
  linkMemberAccount,
  listTeamRequests,
  promoteToTeamLead,
  saveMemberPayee,
  setDealerCommissionModel,
  setDealerTierRates,
  setMemberPlacement,
  teamTree,
  tierRule,
  tradingProgress,
  verifyMemberBank,
} from "@/server/dealers/tiered";
import { getRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

const reason = z.string().max(500);
const bp = z.number().int().min(0).max(10_000).nullable();
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setModel"), dealerId: z.string().uuid(), model: z.enum(["STANDARD", "TIERED"]), reason }),
  z.object({ action: z.literal("setRates"), dealerId: z.string().uuid(), directBp: bp, leadOverrideBp: bp, mainOverrideBp: bp, reason }),
  z.object({
    action: z.literal("addMember"),
    dealerId: z.string().uuid(),
    employeeId: z.string().max(48),
    name: z.string().max(120),
    mobile: z.string().max(20).nullish(),
    role: z.enum(TEAM_ROLES),
    parentId: z.string().uuid().nullish(),
  }),
  z.object({ action: z.literal("placeMember"), memberId: z.string().uuid(), role: z.enum(TEAM_ROLES), parentId: z.string().uuid().nullable(), reason }),
  z.object({ action: z.literal("promote"), memberId: z.string().uuid(), reason, override: z.boolean().optional() }),
  z.object({ action: z.literal("decideRequest"), requestId: z.string().uuid(), approve: z.boolean(), note: z.string().max(500).nullish() }),
  z.object({
    action: z.literal("payee"),
    memberId: z.string().uuid(),
    pan: z.string().max(10).nullish(),
    bankHolderName: z.string().max(120).nullish(),
    bankAccount: z.string().max(24).nullish(),
    ifsc: z.string().max(11).nullish(),
  }),
  z.object({ action: z.literal("verifyBank"), memberId: z.string().uuid(), verified: z.boolean(), reason }),
  z.object({ action: z.literal("linkAccount"), memberId: z.string().uuid(), email: z.string().email().max(200) }),
]);

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  await requireRole("ADMIN", "OPERATOR");
  const dealerId = z.string().uuid().safeParse(request.nextUrl.searchParams.get("dealerId")).data;
  const [rule, tds, requests] = await Promise.all([tierRule(), getRule("dealerPayoutTds"), listTeamRequests()]);
  if (!dealerId) return ok({ rule, tds, requests });
  const [tree, earnings, trading] = await Promise.all([teamTree(dealerId), earningsByType(dealerId), tradingProgress(dealerId)]);
  return ok({ rule, tds, requests, tree, earnings, trading });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "setModel": {
      const d = await setDealerCommissionModel(body.dealerId, body.model, body.reason, admin);
      return ok({ dealerId: d.id, commissionModel: d.commissionModel });
    }
    case "setRates": {
      const d = await setDealerTierRates(body.dealerId, { directBp: body.directBp, leadOverrideBp: body.leadOverrideBp, mainOverrideBp: body.mainOverrideBp }, body.reason, admin);
      return ok({ dealerId: d.id, tierDirectBp: d.tierDirectBp, tierLeadOverrideBp: d.tierLeadOverrideBp, tierMainOverrideBp: d.tierMainOverrideBp });
    }
    case "addMember":
      return ok({ member: await addSalesperson(body.dealerId, { employeeId: body.employeeId, name: body.name, mobile: body.mobile, role: body.role, parentId: body.parentId ?? null }, admin) });
    case "placeMember": {
      const m = await setMemberPlacement(body.memberId, { role: body.role, parentId: body.parentId }, body.reason, admin);
      return ok({ memberId: m.id, role: m.teamRole, level: m.depth, parentId: m.parentId });
    }
    case "promote": {
      const r = await promoteToTeamLead(body.memberId, { reason: body.reason, override: body.override }, admin);
      return ok({ memberId: r.member.id, role: r.member.teamRole, movedAgents: r.movedAgents, developmentId: r.developmentId });
    }
    case "decideRequest":
      return ok(await decideTeamRequest(body.requestId, body.approve, body.note ?? null, admin));
    case "payee": {
      const m = await saveMemberPayee(body.memberId, body, admin);
      return ok({ memberId: m.id, panLast4: m.panLast4, bankLast4: m.bankAccountLast4, bankStatus: m.bankStatus });
    }
    case "verifyBank": {
      const m = await verifyMemberBank(body.memberId, body.verified, body.reason, admin);
      return ok({ memberId: m.id, bankStatus: m.bankStatus });
    }
    case "linkAccount": {
      const m = await linkMemberAccount(body.memberId, body.email, admin);
      return ok({ memberId: m.id, linked: Boolean(m.userId) });
    }
  }
});
