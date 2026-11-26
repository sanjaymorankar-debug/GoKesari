/**
 * My Zone (Rider App v2): working radius on a map, the rider's societies, busy areas in the last
 * hour (order counts only — no customer details) and any live surge. Without a Maps key the
 * lists are shown on their own.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { RG, fill } from "@/components/rider-growth/text";
import { ZoneMap } from "@/components/rider-growth/zone-map";
import { Alert, Card, PageHeader } from "@/components/ui";
import { tr, type Text } from "@/lib/board/i18n";
import { formatPaiseCompact } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getRiderZone } from "@/server/services/rider-zone";

export const metadata = { title: "My Zone" };
export const dynamic = "force-dynamic";

const timeIST = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date(iso));

export default async function RiderZonePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/delivery-partner/zone");
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner");
  const [zone, lang] = await Promise.all([getRiderZone(partner.id), getBoardLang()]);
  const l = (text: Text) => tr(text, lang);

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-testid="rider-zone-page">
      <PageHeader title={l(RG.zoneTitle)} description={l(RG.zoneIntro)} />

      {zone.surges.length > 0 ? (
        <div className="space-y-2" data-testid="rider-zone-surges">
          {zone.surges.map((s, i) => (
            <div key={i} className="rounded-2xl border-2 border-red-200 bg-red-50 p-3 text-sm text-red-900">
              <strong>{l(RG.surgeNow)}: </strong>
              {s.label}
              {s.multiplierBp > 10000 ? ` · ×${(s.multiplierBp / 10000).toFixed(2).replace(/\.?0+$/, "")}` : ""}
              {s.flatPaise > 0 ? ` · +${formatPaiseCompact(s.flatPaise)}` : ""}
              {` · ${l(RG.until)} ${timeIST(s.endsAt)}`}
            </div>
          ))}
        </div>
      ) : null}

      <Card className="p-4">
        <p className="text-sm text-ink-700">
          <strong>{l(RG.radius)}:</strong> {zone.radiusKm} {l(RG.km)}
          {zone.centreSource ? ` · ${l(zone.centreSource === "LIVE" ? RG.centreLive : RG.centreRegistered)}` : ""}
        </p>
        {zone.centre ? (
          <div className="mt-3">
            <ZoneMap
              centre={zone.centre}
              radiusKm={zone.radiusKm}
              societies={zone.societies}
              hotspots={zone.hotspots}
              note={l(RG.mapNote)}
            />
          </div>
        ) : (
          <div className="mt-3">
            <Alert tone="info">{l(RG.noLocation)}</Alert>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-lg font-semibold text-ink-900">{fill(l(RG.hotspots), { m: zone.windowMinutes })}</h2>
        {zone.hotspots.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">{l(RG.noHotspots)}</p>
        ) : (
          <ul className="mt-2 divide-y divide-cream-100" data-testid="rider-zone-hotspots">
            {zone.hotspots.map((h) => (
              <li key={h.key} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 text-ink-800">
                  {h.label}
                  {h.distanceKm != null ? <span className="text-xs text-ink-500"> · {h.distanceKm} {l(RG.km)}</span> : null}
                </span>
                <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-800">
                  {h.orders} {l(RG.orders)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-lg font-semibold text-ink-900">{l(RG.mySocieties)}</h2>
        {zone.societies.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">{l(RG.noSocieties)}</p>
        ) : (
          <ul className="mt-2 divide-y divide-cream-100" data-testid="rider-zone-societies">
            {zone.societies.map((s) => (
              <li key={s.id} className="py-2 text-sm text-ink-800">
                {s.name}
                <span className="text-xs text-ink-500">
                  {" "}
                  · {[s.area, s.city].filter(Boolean).join(", ")}
                  {s.distanceKm != null ? ` · ${s.distanceKm} ${l(RG.km)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Link href="/delivery-partner" className="inline-flex min-h-12 items-center text-sm font-semibold text-kesari-700 underline">
        {l(RG.back)}
      </Link>
    </div>
  );
}
