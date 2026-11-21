import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { rupees } from "@/lib/franchise";
import { commissionChart, type ChartRow } from "@/server/franchise/chart";

export const metadata = { title: "Commission chart — GoKesari dealers and franchises" };
export const dynamic = "force-dynamic";

const pct = (bp: number) => (bp ? `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%` : "—");

function CaseTable({ title, rows, top, examples }: { title: string; rows: ChartRow[]; top: string; examples: readonly { key: string; label: string; feePaise: number }[] }) {
  return (
    <Card className="space-y-2 p-4">
      <h2 className="text-base font-bold text-ink-900">{title}</h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm" data-testid={`chart-${top === "Dealer" ? "A" : "B"}`}>
          <thead className="text-left text-xs text-ink-500">
            <tr>
              <th className="py-1 pr-2">#</th>
              <th className="py-1 pr-2">Who registered the shop</th>
              <th className="py-1 pr-2 text-right">Registering person</th>
              <th className="py-1 pr-2 text-right">Team Lead</th>
              <th className="py-1 pr-2 text-right">{top}</th>
              {examples.map((e) => (
                <th key={e.key} className="py-1 pr-2 text-right">
                  {e.label} {rupees(e.feePaise)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.caseCode} className="border-t border-cream-100 align-top">
                <td className="py-1 pr-2 font-semibold">{r.caseCode}</td>
                <td className="py-1 pr-2">{r.who}</td>
                <td className="py-1 pr-2 text-right">{pct(r.directBp)}</td>
                <td className="py-1 pr-2 text-right">{pct(r.leadBp)}</td>
                <td className="py-1 pr-2 text-right">{pct(r.topBp)}</td>
                {r.amounts.map((a) => (
                  <td key={a.key} className="py-1 pr-2 text-right">
                    {[a.direct ? rupees(a.direct) : null, a.lead ? `TL ${rupees(a.lead)}` : null, `${top} ${rupees(a.top)}`].filter(Boolean).join(" + ")}
                    <div className="text-xs text-ink-500">= {rupees(a.total)}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Public Commission Chart (final brief 21-Nov-2026 §9): the free dealership and the paid franchise side by side, from
 * the live Admin configuration, so everyone sees the same rules upfront. Same work, same pay; GoKesari pays everyone.
 */
export default async function CommissionChartPage() {
  const c = await commissionChart();
  const r = c.recurring;
  const lakh = rupees(r.expectedBusinessPerShopPaise);
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6" data-testid="commission-chart">
      <PageHeader title="Commission chart" description="Same work, same pay — and GoKesari pays everyone directly, on the 5th of every month, after TDS." />
      <Card className="space-y-1 p-4 text-sm text-ink-700">
        <p>One-time commission is a share of the shop&apos;s registration fee excluding GST, earned when the shop is activated (fee paid and verification passed).</p>
        <p>
          An agent earns {pct(c.rates.memberDirectBp)} and a team lead {pct(c.rates.leadOverrideBp)} on his agents&apos; shops in both models. Each person needs PAN and a verified bank account before payout; commission builds up meanwhile.
        </p>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <CaseTable title="Free Dealership (Model A)" rows={c.modelA} top="Dealer" examples={c.examples} />
        <CaseTable title="Paid Franchise (Model B)" rows={c.modelB} top="Owner" examples={c.examples} />
      </div>
      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">Recurring commission — paid franchise only</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700" data-testid="chart-recurring">
          <li>
            GoKesari&apos;s order commission is {pct(r.gokesariCommissionBp)} on every delivered order. The franchise owner earns {pct(r.recurringBaseBp)} of it on every delivered order of the shops attached to his zone. Cancelled, refunded or disputed orders are excluded or reversed.
          </li>
          <li>
            Monthly performance bonus, up to +{pct(r.bonusMaxBp)} (so at most {pct(r.recurringBaseBp + r.bonusMaxBp)}): baseline = attached shops at the end of last month × {lakh} expected monthly business; each new shop above the target of {r.monthlyShopTarget} = 1 base point; each {rupees(r.businessSlotPaise)} of business above the baseline = 1 base point; {r.basePointsPerMainPoint} base points = {pct(r.bonusBpPerMainPoint)}, shown to one decimal (30 base points → {pct(r.recurringBaseBp + 30)}).
          </li>
          <li>The bonus is worked out every month and can go up or down; it is paid on the 5th of the next month.</li>
          <li>
            A franchise is {r.validityMonths} months, renewed yearly; at most {r.maxOwnersPerZone} franchises a zone. If an owner stops renewing, he keeps recurring commission on shops his own team registered for {r.tailYears} more years.
          </li>
          <li>Agents and team leads earn no recurring commission. Free dealers earn none either.</li>
        </ul>
        <p className="text-xs text-ink-500">These are the current rates from GoKesari&apos;s settings. They are not a promise of earnings.</p>
      </Card>
      <p className="text-sm">
        <Link className="font-semibold text-kesari-800 underline" href="/franchise">
          About the paid franchise
        </Link>{" "}
        ·{" "}
        <Link className="font-semibold text-kesari-800 underline" href="/dealer/apply">
          Apply free as a dealer
        </Link>
      </p>
    </div>
  );
}
