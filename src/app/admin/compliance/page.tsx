import { redirect } from "next/navigation";

import { GenerateReturnButton, MarkFiledForm } from "@/components/billing/compliance-actions";
import { Alert, Badge, Card, PageHeader, Section } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getFeatureFlags } from "@/server/services/feature-flags";
import { countUnconfirmedStatutoryRates, istDay } from "@/server/statutory/rates";
import { complianceCalendar, monthBounds } from "@/server/tax/compliance";
import { moneyFlowSummary } from "@/server/tax/money-flow";

export const metadata = { title: "Tax returns & due dates" };
export const dynamic = "force-dynamic";

const MODE_LABEL = {
  ONLINE_PREPAID: "Paid online",
  WALLET_PREPAID: "Paid from wallet",
  COD_PLATFORM_RIDER: "Cash to GoKesari rider",
  COD_SHOP: "Cash to the shop's own delivery",
  PICKUP_PAID_AT_SHOP: "Pickup, paid at the shop",
} as const;

const STATUS_TONE = { NOT_GENERATED: "danger", GENERATED: "warning", SUBMITTED: "info", FILED: "success" } as const;

/**
 * Admin → Tax returns & due dates (billing v2, docs/billing §5.7): GoKesari's
 * own GSTR-8, GSTR-1, GSTR-3B and quarterly TDS statement — what is due, its
 * status, generate / download / mark filed — on one screen.
 */
export default async function CompliancePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.STATUTORY_MANAGE)) redirect("/");
  const flags = await getFeatureFlags();
  if (!flags.billing_v2.enabled) redirect("/admin");
  const today = istDay(new Date());
  const month = monthBounds(today.slice(0, 7));
  const [items, unconfirmed, flows] = await Promise.all([
    complianceCalendar(today),
    countUnconfirmedStatutoryRates(),
    moneyFlowSummary(new Date(`${month.from}T00:00:00+05:30`), new Date(`${month.to}T00:00:00+05:30`)),
  ]);
  const engines = [
    { key: "tcs_engine", label: "TCS engine", on: flags.tcs_engine.enabled },
    { key: "tds_engine", label: "TDS engine", on: flags.tds_engine.enabled },
    { key: "delivery_9_5", label: "s.9(5) delivery GST", on: flags.delivery_9_5.enabled },
    { key: "gsp_live", label: "GST portal (GSP)", on: flags.gsp_live.enabled },
  ];
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Tax returns & due dates" description="GoKesari's own returns as an e-commerce operator. Generate, download for the CA or GSP, then record the acknowledgement once filed." />
      {unconfirmed > 0 ? (
        <div className="mb-3">
          <Alert tone="danger" title={`${unconfirmed} tax setting(s) not confirmed by the CA`}>
            Rates and switches under Admin → TCS / TDS settings are not confirmed yet: check them with the CA before filing.
          </Alert>
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap gap-1.5" data-testid="compliance-engines">
        {engines.map((e) => (
          <Badge key={e.key} tone={e.on ? "success" : "neutral"}>
            {e.label}: {e.on ? "on" : "off"}
          </Badge>
        ))}
      </div>
      <Section title="Due now and next">
        <ul className="grid gap-2 sm:grid-cols-2" data-testid="compliance-items">
          {items.map((i) => (
            <li key={`${i.returnType}-${i.period}`}>
              <Card className="flex h-full flex-col gap-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-ink-900">{i.label}</p>
                    <p className={`text-xs ${i.daysLeft < 0 && i.status !== "FILED" ? "font-bold text-red-700" : "text-ink-600"}`}>
                      Due {i.dueDate} · {i.daysLeft < 0 ? `${-i.daysLeft} day(s) overdue` : i.daysLeft === 0 ? "today" : `in ${i.daysLeft} day(s)`}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[i.status]}>{i.status.replace("_", " ").toLowerCase()}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {i.status !== "FILED" ? <GenerateReturnButton returnType={i.returnType} period={i.period} label={i.status === "NOT_GENERATED" ? "Generate" : "Regenerate"} /> : null}
                  {i.filingId ? (
                    <a className="text-sm font-semibold text-kesari-800 underline" href={`/api/admin/compliance/filings/${i.filingId}`}>
                      Download JSON
                    </a>
                  ) : null}
                  {i.returnType === "TDS_STATEMENT" ? (
                    <a className="text-sm font-semibold text-kesari-800 underline" href={`/api/admin/compliance/tds-statement?quarter=${i.period}`}>
                      CSV with PANs
                    </a>
                  ) : null}
                </div>
                {i.filingId && i.status !== "FILED" ? <MarkFiledForm filingId={i.filingId} /> : null}
              </Card>
            </li>
          ))}
        </ul>
      </Section>
      <Section title={`Money flow — orders delivered in ${today.slice(0, 7)}`}>
        <p className="mb-2 text-sm text-ink-600">Who received each customer&apos;s money decides TCS and TDS (§5.1). Settled: the shop payout carrying the order has been paid.</p>
        {flows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="money-flow-summary">
              <thead>
                <tr className="text-left text-xs text-ink-600">
                  <th className="p-1.5">Payment</th>
                  <th className="p-1.5">Money with</th>
                  <th className="p-1.5 text-right">Orders</th>
                  <th className="p-1.5 text-right">TCS</th>
                  <th className="p-1.5 text-right">TDS</th>
                  <th className="p-1.5 text-right">s.9(5) delivery GST</th>
                  <th className="p-1.5 text-right">s.9(5) food GST</th>
                  <th className="p-1.5 text-right">Settled</th>
                </tr>
              </thead>
              <tbody>
                {flows.map((f) => (
                  <tr key={`${f.mode}-${f.collectedBy}`} className="border-t border-[var(--gk-line)]">
                    <td className="p-1.5">{MODE_LABEL[f.mode]}</td>
                    <td className="p-1.5">{f.collectedBy === "PLATFORM" ? "GoKesari" : "Shop"}</td>
                    <td className="p-1.5 text-right tabular-nums">{f.orders}</td>
                    <td className="p-1.5 text-right tabular-nums">{f.tcsApplicable}</td>
                    <td className="p-1.5 text-right tabular-nums">{f.tdsApplicable}</td>
                    <td className="p-1.5 text-right tabular-nums">{formatPaise(f.deliveryGstPaise)}</td>
                    <td className="p-1.5 text-right tabular-nums">{formatPaise(f.foodGstPaise)}</td>
                    <td className="p-1.5 text-right tabular-nums">
                      {f.settled} / {f.orders}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-ink-600">No delivered orders recorded this month yet.</p>
        )}
      </Section>
    </div>
  );
}
