import Link from "next/link";

import { Alert, Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { ESTIMATE_DISCLOSURE, FRANCHISE_AGREEMENT_TEXT, FRANCHISE_CONTACT_PHONE, ILLUSTRATION_DISCLOSURE, crore, rupees } from "@/lib/franchise";
import { offerView } from "@/server/franchise/booking";
import { franchiseConfig } from "@/server/franchise/config";
import { clusterSummary, listClusters, zoneViews } from "@/server/franchise/zones";

export const metadata = { title: "GoKesari Franchise — Pune" };
export const dynamic = "force-dynamic";

/**
 * Public franchise page (brief §4.5 step 1): Pune-only launch, the fee, 12 months, at most 2 owners an area,
 * the launch counter, how earnings work (illustration only), the rules, and the free dealership.
 */
export default async function FranchisePage() {
  const [offer, { config }, zones, clusters] = await Promise.all([offerView(), franchiseConfig(), zoneViews(), listClusters()]);
  const summary = clusterSummary(zones, clusters);
  const fee = offer.feePerAreaPaise;
  const share = config.recurringBaseBp / 100;
  const max = (config.recurringBaseBp + config.bonusMaxBp) / 100;
  const oneTime = config.oneTimeBp / 100;
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6" data-testid="franchise-info">
      <PageHeader title="GoKesari Territory Franchise — Pune" description="Own a Pune area on GoKesari: onboard local shops, support them, and earn on every order they complete." />

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">Pune Metropolitan Region only</Badge>
          <Badge tone="neutral">{summary.total.zones} areas · 7 clusters</Badge>
          {offer.launch.open ? (
            <Badge tone="success">
              {offer.launch.placesLeft} of {offer.launch.placesTotal} launch places left
            </Badge>
          ) : (
            <Badge tone="warning">Launch offer closed</Badge>
          )}
        </div>
        {fee != null ? (
          <p className="text-lg font-semibold text-ink-900">
            {rupees(fee)} per area for {offer.validityMonths} months + GST · 100% upfront, online · at most {offer.maxOwnersPerZone} owners an area
          </p>
        ) : (
          <Alert tone="warning" title="Launch offer closed – new terms coming soon">
            Leave your details on WhatsApp or call <a className="font-semibold underline" href={`https://wa.me/${FRANCHISE_CONTACT_PHONE.replace(/\D/g, "")}`}>{FRANCHISE_CONTACT_PHONE}</a>.
          </Alert>
        )}
        {offer.closedMessage && fee != null ? <Alert tone="info">{offer.closedMessage}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/franchise/book">Choose your areas</LinkButton>
          <LinkButton href="/franchise/my" variant="secondary">
            My franchise
          </LinkButton>
        </div>
        <p className="text-xs text-ink-500">The fee is non-refundable (subject to applicable law). Renewal is manual, at the fee then in force — never charged automatically.</p>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">How you earn</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
          <li>
            <strong>{oneTime}%</strong> of each shop&apos;s registration fee (excluding GST) when a shop you register with your franchise code is activated — {rupees(Math.round(100_000 * config.oneTimeBp / 10_000))} on a ₹1,000 retail shop.
          </li>
          <li>
            <strong>{share}%</strong> of GoKesari&apos;s 2% order commission on every completed order of those shops, every month — plus a performance bonus of 0 to {config.bonusMaxBp / 100} points (up to {max}%).
          </li>
          <li>Recurring commission on shops you registered continues until the end of year 3 from your first activation, even if you do not renew.</li>
          <li>Paid on the 5th of every month after TDS, with a statement.</li>
        </ul>
        <div className="rounded-lg bg-cream-50 p-3 text-sm text-ink-700" data-testid="franchise-illustration">
          <p>
            One shop selling ₹1,00,000 a month → GoKesari 2% = ₹2,000 → you {share}% = <strong>{rupees(200_000 * config.recurringBaseBp / 10_000)}</strong> a month ({rupees(200_000 * (config.recurringBaseBp + config.bonusMaxBp) / 10_000)} at {max}%).
          </p>
          <p>100 such shops → {rupees(100 * Math.round(100_000 * config.oneTimeBp / 10_000))} one-time + {rupees(100 * 200_000 * config.recurringBaseBp / 10_000)}–{rupees(100 * 200_000 * (config.recurringBaseBp + config.bonusMaxBp) / 10_000)} a month.</p>
          <p className="mt-1 text-xs text-ink-500">{ILLUSTRATION_DISCLOSURE} 1-year view only.</p>
        </div>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">The 7 Pune clusters</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="cluster-summary">
            <thead className="text-left text-xs text-ink-500">
              <tr>
                <th className="py-1 pr-3">Cluster</th>
                <th className="py-1 pr-3 text-right">Areas</th>
                <th className="py-1 pr-3 text-right">Est. shops</th>
                <th className="py-1 pr-3 text-right">Est. annual area business (₹ Cr)</th>
                <th className="py-1 text-right">Largest area (₹ Cr)</th>
              </tr>
            </thead>
            <tbody>
              {[...summary.clusters, summary.total].map((c) => (
                <tr key={c.code} className={c.code === "PMR" ? "border-t border-cream-200 font-semibold" : ""}>
                  <td className="py-1 pr-3">{c.code === "PMR" ? "Total PMR" : `${c.code} · ${c.name}`}</td>
                  <td className="py-1 pr-3 text-right">{c.zones}</td>
                  <td className="py-1 pr-3 text-right">{c.estShops.toLocaleString("en-IN")}</td>
                  <td className="py-1 pr-3 text-right">{crore(Math.round(c.annualCrHundredths / 100) * 100)}</td>
                  <td className="py-1 text-right">{crore(Math.round(c.largestZoneCrHundredths / 100) * 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-500">{ESTIMATE_DISCLOSURE}</p>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">Responsibilities and rules</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
          {FRANCHISE_AGREEMENT_TEXT.slice(1).map((line) => (
            <li key={line.slice(0, 40)}>{line}</li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">Not ready for a paid area? Become a free dealer</h2>
        <p className="text-sm text-ink-700">
          Free dealership, anywhere in Pune: 20% of every shop you register, 4% when someone directly under you registers one, 3% two levels down. Build a team of team leads and agents. You can buy paid areas later with the same account.
        </p>
        <Link className="text-sm font-semibold text-kesari-800 underline" href="/dealer/apply">
          Apply free as a dealer
        </Link>
      </Card>

      <p className="text-center text-sm text-ink-600">
        Questions? WhatsApp or call <a className="font-semibold text-kesari-800 underline" href={`tel:${FRANCHISE_CONTACT_PHONE.replace(/\s/g, "")}`}>{FRANCHISE_CONTACT_PHONE}</a>
      </p>
    </div>
  );
}
