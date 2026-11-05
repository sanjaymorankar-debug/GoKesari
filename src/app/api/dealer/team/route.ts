/**
 * The dealer portal's TIERED network (docs/dealer-programme/TIERED_COMMISSION.md), for a
 * main dealer and for a team lead or agent signed in with their own account.
 *
 * GET ?view=mapping[&format=csv] / ?view=history → the main dealer's team mapping table and history;
 *     ?view=shops → my own shops (drill-down);
 *     ?view=performance[&period=DAY|WEEK|MONTH][&format=csv] → shops and commission per person
 *     (the main dealer: everyone; a lead: his team; an agent: himself), MONTH = this month so far, live.
 * GET → who I am in the network, the team tree (main dealer and leads), my earnings by type
 *     and level, and the TRADING progress of my shops.
 * POST { action, … }:
 *   acceptAgreement {version} — before any commission is paid (held until then)
 *   requestSubAgent {employeeId, name, mobile?, note?} — a team member asks; an admin decides
 *   addMember {employeeId, name, mobile?, role, parentId?} — the main dealer, in their own network
 *   payee {pan?, bankHolderName?, bankAccount?, ifsc?} — a team member's own payment details
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { TEAM_ROLES } from "@/lib/dealer-tiers";
import { forbidden } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { addSalesperson, getDealerForUser } from "@/server/dealers/service";
import { reportPeriod, teamReport, teamReportCsv } from "@/server/dealers/team-report";
import {
  acceptAgentAgreement,
  earningsByType,
  getMemberForUser,
  mappingHistory,
  memberShops,
  requestSubAgent,
  saveMemberPayee,
  teamMapping,
  teamMappingCsv,
  teamTree,
  tradingProgress,
} from "@/server/dealers/tiered";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("acceptAgreement"), version: z.string().max(20) }),
  z.object({ action: z.literal("requestSubAgent"), employeeId: z.string().max(48), name: z.string().max(120), mobile: z.string().max(20).nullish(), note: z.string().max(500).nullish() }),
  z.object({ action: z.literal("addMember"), employeeId: z.string().max(48), name: z.string().max(120), mobile: z.string().max(20).nullish(), role: z.enum(TEAM_ROLES), parentId: z.string().uuid().nullish() }),
  z.object({ action: z.literal("payee"), pan: z.string().max(10).nullish(), bankHolderName: z.string().max(120).nullish(), bankAccount: z.string().max(24).nullish(), ifsc: z.string().max(11).nullish() }),
]);

async function whoAmI(userId: string) {
  const dealer = await getDealerForUser(userId);
  if (dealer && dealer.status === "APPROVED") return { dealer, member: null };
  const mine = await getMemberForUser(userId);
  if (mine && mine.dealer.status === "APPROVED") return mine;
  throw forbidden("Only an approved dealer or a member of a dealer team can see this.");
}

export const GET = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  const { dealer, member } = await whoAmI(user.id);
  const params = request.nextUrl.searchParams;
  // Gap report A9: the main dealer's team mapping table (CSV) and history; anyone's own shops.
  if (params.get("view") === "mapping") {
    if (member) throw forbidden("Only the main dealer sees the whole team mapping.");
    const rows = await teamMapping(dealer.id);
    if (params.get("format") === "csv") {
      return new NextResponse(teamMappingCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="my-team.csv"', "cache-control": "private, no-store" } });
    }
    return ok({ rows });
  }
  if (params.get("view") === "history") {
    if (member) throw forbidden("Only the main dealer sees the team history.");
    return ok({ history: await mappingHistory(dealer.id) });
  }
  if (params.get("view") === "shops") return ok({ shops: await memberShops(dealer.id, member ? member.id : null) });
  if (params.get("view") === "performance") {
    const kind = z.enum(["DAY", "WEEK", "MONTH"]).catch("MONTH").parse(params.get("period"));
    const report = await teamReport(dealer.id, reportPeriod(kind), member);
    if (params.get("format") === "csv") {
      return new NextResponse(teamReportCsv(report), {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="team-performance-${report.period.fromDate}.csv"`, "cache-control": "private, no-store" },
      });
    }
    return ok({ report });
  }
  const [tree, earnings, trading] = await Promise.all([
    !member || member.teamRole === "TEAM_LEAD" ? teamTree(dealer.id) : null,
    earningsByType(dealer.id, member ? member.id : null),
    tradingProgress(dealer.id, member?.id ?? null),
  ]);
  // A lead sees his own branch of the tree only.
  const visible = tree && member ? { ...tree, members: tree.members.filter((m) => m.id === member.id) } : tree;
  return ok({ me: member ? { memberId: member.id, role: member.teamRole, level: member.depth } : { memberId: null, role: "MAIN_DEALER", level: 1 }, tree: visible, earnings, trading });
});

export const POST = route(async (request: NextRequest) => {
  await requireDealerProgramme();
  const user = await requireUser();
  const body = await parseBody(request, schema);
  const actor = { id: user.id, role: user.role };
  switch (body.action) {
    case "acceptAgreement":
      return ok(
        await acceptAgentAgreement(actor, body.version, {
          ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
          userAgent: request.headers.get("user-agent"),
        }),
      );
    case "requestSubAgent":
      return ok(await requestSubAgent(actor, body));
    case "addMember": {
      const dealer = await getDealerForUser(user.id);
      if (!dealer || dealer.status !== "APPROVED") throw forbidden("Only the main dealer adds members; a team member asks for a sub-agent instead.");
      return ok({ member: await addSalesperson(dealer.id, { employeeId: body.employeeId, name: body.name, mobile: body.mobile, role: body.role, parentId: body.parentId ?? null }, actor) });
    }
    case "payee": {
      const mine = await getMemberForUser(user.id);
      if (!mine) throw forbidden("Only a team member sets their payment details here; a dealer uses their application.");
      const m = await saveMemberPayee(mine.member.id, body, actor);
      return ok({ panLast4: m.panLast4, bankLast4: m.bankAccountLast4, bankStatus: m.bankStatus });
    }
  }
});
