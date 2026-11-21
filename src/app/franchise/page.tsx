import Link from "next/link";

import { Alert, Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { TierBadge } from "@/components/franchise/zone-bits";
import { FRANCHISE_AGREEMENT_TEXT, FRANCHISE_CONTACT_PHONE, ILLUSTRATION_DISCLOSURE, rupees } from "@/lib/franchise";
import { offerView } from "@/server/franchise/booking";
import { commissionChart } from "@/server/franchise/chart";
import { zoneFacets, zoneViews } from "@/server/franchise/zones";

export const metadata = { title: "GoKesari Franchise — Pune, Mumbai (Konkan), Nashik" };
export const dynamic = "force-dynamic";

const pct = (bp: number) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;

/**
 * Public franchise page (final brief 21-Nov-2026): 50 Pune zones in three tiers, each with its own annual fee, at most
 * 2 franchises a zone, the launch counter, how the paid franchise earns (from the live commission chart), the rules,
 * and the free dealership. GoKesari pays everyone in the team directly.
 */
export default async function FranchisePage() {
  const [offer, chart, zones] = await Promise.all([offerView(), commissionChart(), zoneViews()]);
  const facets = zoneFacets(zones);
  const fees = zones.map((z) => z.feePaise).filter((f): f is number => f != null);
  const regular = zones.map((z) => z.regularFeePaise).filter((f): f is number => f != null);
  const r = chart.rates;
  const rec = chart.recurring;
  const provisional = zones.some((z) => z.provisional);
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6" data-testid="franchise-info">
      <PageHeader title="GoKesari Territory Franchise" description="Own a zone in Pune, Mumbai (Konkan) or Nashik on GoKesari: build your team, onboard local shops, support them, and earn on every order they complete." />

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">{[...new Set(zones.map((z) => z.setName))].join(" · ")}</Badge>
          <Badge tone="neutral">{zones.length} zones</Badge>
          {offer.launch.open ? (
            <Badge tone="success">
              Launch offer: {offer.launch.placesLeft} of {offer.launch.placesTotal} places left
            </Badge>
          ) : (
            <Badge tone="warning">Launch offer closed</Badge>
          )}
        </div>
        {offer.launch.open && fees.length ? (
          <p className="text-lg font-semibold text-ink-900">
            {offer.promoFeePaise != null ? (
              <>Launch offer {rupees(offer.promoFeePaise)} + GST a year for every zone (regular rates {rupees(Math.min(...regular))} to {rupees(Math.max(...regular))}, by zone)</>
            ) : (
              <>Annual fee from {rupees(Math.min(...fees))} to {rupees(Math.max(...fees))} + GST, by zone</>
            )}{" "}
            · {offer.validityMonths} months · 100% upfront, online · at most {offer.maxOwnersPerZone} franchises a zone
          </p>
        ) : (
          <Alert tone="warning" title="Launch offer closed – new terms coming soon">
            Leave your details on WhatsApp or call <a className="font-semibold underline" href={`https://wa.me/${FRANCHISE_CONTACT_PHONE.replace(/\D/g, "")}`}>{FRANCHISE_CONTACT_PHONE}</a>.
          </Alert>
        )}
        {provisional ? <p className="text-sm text-ink-600">Regular zone rates are provisional while GoKesari finalises the business figures.</p> : null}
        {offer.closedMessage && offer.launch.open ? <Alert tone="info">{offer.closedMessage}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/franchise/book">See the zones</LinkButton>
          <LinkButton href="/franchise/my" variant="secondary">
            My franchise
          </LinkButton>
          <LinkButton href="/dealer/commission-chart" variant="secondary">
            Commission chart
          </LinkButton>
        </div>
        <p className="text-xs text-ink-500">The fee is non-refundable (subject to applicable law). Renewal is manual, at the zone&apos;s published fee then — never charged automatically.</p>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">Three kinds of zone</h2>
        <p className="text-sm text-ink-700">Each zone&apos;s fee follows its business compared with its city&apos;s zone average. Every tier is a good opportunity: Emerging zones grow fast and cost less to enter.</p>
        <ul className="space-y-1 text-sm text-ink-700">
          {facets.tiers.map((t) => (
            <li key={t.tier}>
              <TierBadge name={t.name} colour={t.colour} /> {t.count} zones —{" "}
              {t.tier === "PREMIER" ? "business more than 10% above the average" : t.tier === "STANDARD" ? "business within 10% of the average (the standard fee)" : "business more than 10% below the average, with room to grow"}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">How a franchise earns — GoKesari pays everyone directly</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
          <li>
            Your own shops: <strong>{pct(r.ownerSelfBp)}</strong> of the registration fee (excluding GST) — {rupees(chart.modelB[0].amounts[0].top)} on a ₹1,000 retail shop.
          </li>
          <li>
            Every shop your team registers in your zone: <strong>{pct(r.ownerOverrideBp)}</strong> to you when the agent or team lead reports to you directly, <strong>{pct(r.ownerSecondOverrideBp)}</strong> when an agent works under one of your team leads. Your agents get {pct(r.memberDirectBp)} and team leads {pct(r.leadOverrideBp)} on their agents&apos; shops — the same as in a free dealership — paid to them by GoKesari.
          </li>
          <li>
            <strong>{pct(rec.recurringBaseBp)}</strong> of GoKesari&apos;s {pct(rec.gokesariCommissionBp)} order commission on every delivered order of the shops in your zone, every month — plus a performance bonus of up to {pct(rec.bonusMaxBp)}.
          </li>
          <li>Shops your own team registered keep earning you recurring commission for {rec.tailYears} more years if you stop renewing.</li>
          <li>Paid on the 5th of every month after TDS, with a statement.</li>
        </ul>
        <div className="rounded-lg bg-cream-50 p-3 text-sm text-ink-700" data-testid="franchise-illustration">
          <p>
            One shop selling ₹1,00,000 a month → GoKesari {pct(rec.gokesariCommissionBp)} = ₹2,000 → you {pct(rec.recurringBaseBp)} = <strong>{rupees((200_000 * rec.recurringBaseBp) / 10_000)}</strong> a month ({rupees((200_000 * (rec.recurringBaseBp + rec.bonusMaxBp)) / 10_000)} with the full bonus).
          </p>
          <p className="mt-1 text-xs text-ink-500">{ILLUSTRATION_DISCLOSURE} 1-year view only.</p>
        </div>
        <Link className="text-sm font-semibold text-kesari-800 underline" href="/dealer/commission-chart">
          See the full commission chart (free dealership and paid franchise side by side)
        </Link>
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
        <h2 className="text-base font-bold text-ink-900">Not ready for a paid zone? Become a free dealer</h2>
        <p className="text-sm text-ink-700">
          Free dealership, anywhere: {pct(r.dealerSelfBp)} of every shop you register, {pct(r.dealerOverrideBp)} when someone directly under you registers one, {pct(r.dealerSecondOverrideBp)} two levels down. Build a team of team leads and agents. You can buy a paid zone later with the same account; your team keeps the same rates.
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
