import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DealerPortal } from "@/components/dealer/dealer-portal";
import { DealerBoard } from "@/components/dealer/dealer-board";
import { DealerEarnings } from "@/components/dealer/dealer-earnings";
import { DealerStatements } from "@/components/dealer/dealer-statements";
import { dealerPerformance } from "@/server/dealers/performance";
import { DealerWork } from "@/components/dealer/dealer-work";
import { DealerTeam } from "@/components/dealer/dealer-team";
import { DealerTdsCard } from "@/components/dealer/dealer-tds-card";
import { payeeTdsView } from "@/server/tax/commission-tds";
import type { Dealer, DealerSalesperson } from "@/server/db/schema";
import { AGENT_AGREEMENT_VERSION } from "@/lib/dealer-tiers";
import { earningsByType, getMemberForUser, isTieredDealer, teamTree, tierRatesFor, tierRule, tradingProgress } from "@/server/dealers/tiered";
import { applicableRates, commissionSummary, dealerRateView, getCommissionSettings, listLedger, ratingView } from "@/server/dealers/commission";
import { dealerMonthStatement, statementMonths } from "@/server/dealers/monthly-payout";
import { Alert, Badge, LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { activeCodeFor, codeQrSvg, shareLinkFor, whatsappShareFor } from "@/server/dealers/codes";
import { originFromHeaders } from "@/server/dealers/http";
import { listDisputes } from "@/server/dealers/disputes";
import { listLeads } from "@/server/dealers/leads";
import { dealerView, getDealerForUser, listSalespeople } from "@/server/dealers/service";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { listShopCategories } from "@/server/services/shop-categories";
import { listShopTypes } from "@/server/services/shop-types";

export const metadata = { title: "Dealer" };
export const dynamic = "force-dynamic";

/**
 * The dealer's page (docs/dealer-programme): an applicant sees where their
 * application stands; an approved dealer gets their code, QR, share links and
 * employees. Not there at all while the programme is off.
 */
export default async function DealerPage({ searchParams }: { searchParams: Promise<{ statement?: string | string[] }> }) {
  const rawStatement = (await searchParams).statement;
  const openStatement = typeof rawStatement === "string" && /^\d{4}-\d{2}$/.test(rawStatement) ? rawStatement : null;
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/dealer");
  const dealer = await getDealerForUser(user.id);
  // TIERED (0136): a team lead or agent signed in with their own account has their own portal.
  if (!dealer) {
    const mine = await getMemberForUser(user.id);
    if (mine && mine.dealer.status === "APPROVED") return <MemberPortal member={mine.member} dealer={mine.dealer} openStatement={openStatement} />;
  }
  if (!dealer || dealer.status === "DRAFT" || dealer.status === "REJECTED") redirect("/dealer/apply");
  const view = await dealerView(dealer);

  if (dealer.status !== "APPROVED") {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <PageHeader title={dealer.legalName} description="GoKesari dealer" />
        <Alert tone={dealer.status === "PENDING" ? "info" : "warning"} title={view.statusLabel}>
          {dealer.status === "PENDING"
            ? "Your application is with our team. We will tell you when it is decided."
            : dealer.statusReason
              ? `Reason: ${dealer.statusReason}`
              : "Your dealer account is not active."}
        </Alert>
        {dealer.status === "PENDING" ? <LinkButton href="/dealer/apply" variant="secondary">See your application</LinkButton> : null}
      </div>
    );
  }

  const origin = originFromHeaders(await headers());
  const code = await activeCodeFor(dealer.id, null);
  const [employees, performance, leads, claims, shopTypes, categories, feeRule, rating, summary, rates, entries, bonusOn, supportServicesOn, myRate] = await Promise.all([
    listSalespeople(dealer.id),
    dealerPerformance(dealer.id),
    listLeads(dealer.id),
    listDisputes({ dealerId: dealer.id }),
    listShopTypes(),
    listShopCategories({ activeOnly: true, withShopCounts: false }).catch(() => []),
    getRule("registrationFeeByTurnover"),
    ratingView(dealer.id),
    commissionSummary(dealer.id),
    applicableRates(),
    listLedger({ dealerId: dealer.id }),
    isFeatureEnabled("dealer_rating_bonus_enabled"),
    isFeatureEnabled("paid_support_services_enabled"),
    dealerRateView(dealer.id),
  ]);
  // Monthly statements: this month so far and the closed months (owner, 28 Oct 2026).
  const [months, commissionSettings, tiered] = await Promise.all([statementMonths(), getCommissionSettings(), isTieredDealer(dealer)]);
  const network = tiered ? await networkProps(dealer, null) : null;
  const statements = await Promise.all(months.map((m) => dealerMonthStatement(dealer.id, m)));
  // Dates become ISO strings for the client component.
  const iso = (rows: object[]) => JSON.parse(JSON.stringify(rows));
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <PageHeader title={dealer.legalName} description="Authorised GoKesari dealer" />
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
        <Badge tone="success">Approved</Badge>
        {dealer.agreementStart && dealer.agreementEnd ? <span>Agreement {dealer.agreementStart} to {dealer.agreementEnd}</span> : null}
        <Link className="underline" href="/dealer/apply">Your details</Link>
      </p>
      <DealerBoard
        data={iso([performance])[0]}
        ratingText={rating.rating.toFixed(1)}
        bonusText={bonusOn ? `+${(rating.bonusBp / 100).toFixed(1)}% commission` : "rating bonus off"}
        earnedPaise={summary.earned + summary.approved + summary.paid + summary.pending}
        openLeads={leads.filter((l) => l.status === "OPEN").length}
        openClaims={claims.filter((c) => c.status === "OPEN").length}
        activeEmployees={employees.filter((e) => e.status === "ACTIVE").length}
        supportServicesOn={supportServicesOn}
      />
      <DealerPortal
        legalName={dealer.legalName}
        code={code ? { code, shareLink: shareLinkFor(origin, code), whatsapp: whatsappShareFor(origin, code, dealer.legalName), qrSvg: await codeQrSvg(origin, code) } : null}
        employees={employees}
      />
      {network ? <DealerTeam {...network} /> : null}
      <DealerTdsCard view={await payeeTdsView({ panHash: dealer.panHash, dealerType: dealer.dealerType, isMember: false })} />
      <DealerEarnings rating={iso([rating])[0]} summary={summary} rates={rates} myRate={myRate} entries={iso(entries)} bonusOn={bonusOn} />
      <DealerStatements statements={iso(statements)} payoutDay={commissionSettings.payoutDayOfMonth} open={openStatement} />
      <DealerWork
        employees={employees}
        leads={iso(leads)}
        claims={iso(claims)}
        shopTypes={shopTypes.filter((t) => t.status === "ACTIVE").map((t) => ({ key: t.key, label: t.label }))}
        categories={categories.map((c) => ({ id: c.id, name: c.name, status: c.status, groupName: c.groupName ?? null }))}
        askTurnover={feeRule.enabled}
      />
    </div>
  );
}

/** The TIERED network card's data, for the main dealer (member null) or a team member. */
async function networkProps(dealer: Dealer, member: DealerSalesperson | null) {
  const [rule, earnings, trading] = await Promise.all([tierRule(), earningsByType(dealer.id, member ? member.id : null), tradingProgress(dealer.id, member?.id ?? null)]);
  const tree = !member || member.teamRole === "TEAM_LEAD" ? await teamTree(dealer.id) : null;
  const rates = tierRatesFor(dealer, rule);
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  return {
    role: member ? member.teamRole : ("MAIN_DEALER" as const),
    agreementAccepted: member ? member.agreementVersion === AGENT_AGREEMENT_VERSION : dealer.tierAgreementVersion === AGENT_AGREEMENT_VERSION,
    rates: { ...rates, tradingOrders: rule.tradingOrders, tradingDays: rule.tradingDays, renewalBp: rule.renewalEnabled ? rule.renewalBp : null },
    // A lead sees his own branch of the tree only.
    tree: tree ? plain(member ? { ...tree, members: tree.members.filter((m) => m.id === member.id) } : tree) : null,
    earnings,
    trading: plain(trading),
    payee: member ? { panLast4: member.panLast4, bankLast4: member.bankAccountLast4, bankStatus: member.bankStatus } : null,
  };
}

/** A team lead's or agent's own portal (TIERED): their code, network, earnings and statements. */
async function MemberPortal({ member, dealer, openStatement }: { member: DealerSalesperson; dealer: Dealer; openStatement: string | null }) {
  const origin = originFromHeaders(await headers());
  const code = await activeCodeFor(dealer.id, member.id);
  const [network, months, commissionSettings] = await Promise.all([networkProps(dealer, member), statementMonths(), getCommissionSettings()]);
  const statements = await Promise.all(months.map((m) => dealerMonthStatement(dealer.id, m, member.id)));
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <PageHeader title={member.name} description={`${member.teamRole === "TEAM_LEAD" ? "Team lead" : "Agent"} · ${dealer.legalName}`} />
      {code ? (
        <DealerPortal
          legalName={`${dealer.legalName}: ${member.name}`}
          code={{ code, shareLink: shareLinkFor(origin, code), whatsapp: whatsappShareFor(origin, code, member.name), qrSvg: await codeQrSvg(origin, code) }}
          employees={[]}
          showEmployees={false}
        />
      ) : (
        <Alert tone="warning">You have no active code; ask {dealer.legalName} or GoKesari.</Alert>
      )}
      <DealerTeam {...network} />
      <DealerTdsCard view={await payeeTdsView({ panHash: member.panHash, dealerType: dealer.dealerType, isMember: true })} />
      <DealerStatements statements={JSON.parse(JSON.stringify(statements))} payoutDay={commissionSettings.payoutDayOfMonth} open={openStatement} />
    </div>
  );
}
