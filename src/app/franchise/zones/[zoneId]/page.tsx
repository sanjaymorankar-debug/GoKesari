import { notFound } from "next/navigation";

import { Alert, Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { TierBadge, businessText } from "@/components/franchise/zone-bits";
import { ZONE_BADGE_LABELS, rupees } from "@/lib/franchise";
import { offerView } from "@/server/franchise/booking";
import { listAreas, zoneView, type ZoneView } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

async function load(zoneId: string): Promise<ZoneView | null> {
  try {
    return await zoneView(decodeURIComponent(zoneId).toUpperCase());
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ zoneId: string }> }) {
  const z = await load((await params).zoneId);
  return { title: z ? `${z.name} (${z.zoneId}) — GoKesari franchise zone` : "Franchise zone" };
}

/** One franchise zone (final brief 21-Nov-2026 §5.4): tier, fee, % vs average, business and source, areas, description, slots. */
export default async function FranchiseZonePage({ params }: { params: Promise<{ zoneId: string }> }) {
  const z = await load((await params).zoneId);
  if (!z) notFound();
  const [areas, offer] = await Promise.all([listAreas({ zoneId: z.zoneId }), offerView()]);
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6" data-testid={`zone-page-${z.zoneId}`}>
      <PageHeader title={`${z.name}`} description={`Zone ${z.zoneId} · ${z.region}${z.civicBody ? ` · ${z.civicBody}` : ""}`} />
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {z.tierName ? <TierBadge name={z.tierName} colour={z.tierColour} /> : null}
          {z.promoFeePaise != null ? <Badge tone="success">Launch offer</Badge> : null}
          {z.provisional ? <Badge tone="neutral">Provisional</Badge> : null}
          <Badge tone={z.badge === "AVAILABLE" ? "success" : z.badge === "ONE_LEFT" ? "warning" : z.badge === "SOLD_OUT" ? "danger" : "neutral"}>{ZONE_BADGE_LABELS[z.badge]}</Badge>
        </div>
        <p className="text-2xl font-bold text-kesari-800">
          {z.feePaise != null ? rupees(z.feePaise) : "—"} <span className="text-base font-normal text-ink-600">a year + GST{z.promoFeePaise != null ? " · launch offer" : ""} · {z.vsAverage} vs the {z.setName} zone average</span>
        </p>
        {z.promoFeePaise != null && z.regularFeePaise != null ? (
          <p className="text-sm text-ink-700">
            Regular rate after the launch offer: <strong>{rupees(z.regularFeePaise)}</strong> a year + GST{z.provisional ? " (provisional)" : ""}. The fee you pay is locked for your 12-month term.
          </p>
        ) : null}
        <p className="text-ink-800">{z.description}</p>
        <p className="text-sm text-ink-600">{businessText(z)}</p>
        <p className="text-sm text-ink-700">
          {z.slotsFree} of {z.maxOwners} franchise slot{z.maxOwners === 1 ? "" : "s"} left · {offer.validityMonths} months from the verified payment, at the fee paid
        </p>
        {z.provisional && z.promoFeePaise == null && !offer.allowProvisionalSale ? <Alert tone="info">Fees being finalised — this zone opens for booking once its fee is final.</Alert> : null}
        <LinkButton href="/franchise/book">Book this zone</LinkButton>
      </Card>
      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">Areas in this zone</h2>
        <ul className="grid gap-1 text-sm text-ink-700 sm:grid-cols-2" data-testid="zone-areas">
          {areas.map((a) => (
            <li key={a.id}>
              {a.name}
              {a.civicBody ? <span className="text-xs text-ink-500"> · {a.civicBody}</span> : null}
            </li>
          ))}
        </ul>
        <p className="text-xs text-ink-500">A shop belongs to this zone when its area (chosen at registration) is one of these.</p>
      </Card>
    </div>
  );
}
