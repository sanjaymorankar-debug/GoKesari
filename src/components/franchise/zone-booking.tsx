"use client";
import { useEffect, useMemo, useRef, useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";
import { ESTIMATE_DISCLOSURE, ZONE_BADGE_LABELS, bookingAmounts, crore, rupees, type ZoneBadge } from "@/lib/franchise";
import { isMapsAvailable, loadGoogleMaps } from "@/lib/geo/provider";
import type { OfferView } from "@/server/franchise/booking";
import type { ClusterSummary, ZoneView } from "@/server/franchise/zones";

const BADGE_TONE: Record<ZoneBadge, "success" | "warning" | "danger" | "neutral" | "info"> = { AVAILABLE_2: "success", ONE_LEFT: "warning", FULL: "danger", COMING_SOON: "neutral", PAUSED: "neutral" };
const MAP_COLOUR: Record<ZoneBadge, string> = { AVAILABLE_2: "#2f855a", ONE_LEFT: "#d97706", FULL: "#b91c1c", COMING_SOON: "#64748b", PAUSED: "#64748b" };

interface Props {
  zones: ZoneView[];
  clusters: ClusterSummary[];
  offer: OfferView;
  signedIn: boolean;
  owner: { missing: string[]; agreementAccepted: boolean; hasDealer: boolean } | null;
  agreement: { version: string; text: string[] };
}

type Sort = "annual" | "shops" | "zone";

/**
 * Area booking (brief §4.2–4.5): Pune PMR clusters, search, filters, sort, list or map, multi-select with a
 * sticky cart bar, then the summary with the rules (clickwrap) and payment. Prices shown come from the server;
 * the server recalculates everything when the slots are reserved.
 */
export function ZoneBooking({ zones, clusters, offer, signedIn, owner, agreement }: Props) {
  const [cluster, setCluster] = useState("ALL");
  const [q, setQ] = useState("");
  const [availability, setAvailability] = useState<"" | "2" | "1" | "0">("");
  const [origin, setOrigin] = useState<"" | "ORIGINAL" | "SPLIT">("");
  const [minCr, setMinCr] = useState("");
  const [maxCr, setMaxCr] = useState("");
  const [profile, setProfile] = useState("");
  const [sort, setSort] = useState<Sort>("annual");
  const [view, setView] = useState<"list" | "map">("list");
  const [cart, setCart] = useState<string[]>([]);
  const [step, setStep] = useState<"choose" | "summary">("choose");
  const [accepted, setAccepted] = useState(owner?.agreementAccepted ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const profiles = useMemo(() => [...new Set(zones.map((z) => z.commercialProfile))].sort(), [zones]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = zones.filter((z) => {
      if (cluster !== "ALL" && z.clusterCode !== cluster) return false;
      if (availability === "2" && !(z.status === "BOOKABLE" && z.slotsFree >= 2)) return false;
      if (availability === "1" && !(z.status === "BOOKABLE" && z.slotsFree === 1)) return false;
      if (availability === "0" && !(z.status === "BOOKABLE" && z.slotsFree === 0)) return false;
      if (origin === "ORIGINAL" && z.origin !== "ORIGINAL") return false;
      if (origin === "SPLIT" && z.origin === "ORIGINAL") return false;
      if (minCr && z.annualCrHundredths < Number(minCr) * 100) return false;
      if (maxCr && z.annualCrHundredths > Number(maxCr) * 100) return false;
      if (profile && z.commercialProfile !== profile) return false;
      if (needle && !`${z.zoneId} ${z.name} ${z.pinCodes.join(" ")} ${z.commercialProfile}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const key = (z: ZoneView) => {
      const m = /^(\d+)([A-Z]?)(?:-(\d+))?$/.exec(z.zoneId);
      return m ? Number(m[1]) * 10_000 + (m[2] ? m[2].charCodeAt(0) - 64 : 0) * 100 + Number(m[3] ?? 0) : 9e9;
    };
    return out.sort((a, b) => (sort === "zone" ? key(a) - key(b) : sort === "shops" ? b.estShops - a.estShops : b.annualCrHundredths - a.annualCrHundredths) || key(a) - key(b));
  }, [zones, cluster, availability, origin, minCr, maxCr, profile, q, sort]);

  const fee = offer.feePerAreaPaise;
  const amounts = cart.length && fee ? bookingAmounts(cart.length, fee, offer.gstRateBp) : null;
  const toggle = (zoneId: string) => setCart((c) => (c.includes(zoneId) ? c.filter((z) => z !== zoneId) : [...c, zoneId]));
  const canBook = offer.bookingOpen && fee != null;

  async function reserveAndPay() {
    setBusy(true);
    setError(null);
    try {
      if (!accepted) throw new Error("Please read and accept the responsibilities and rules.");
      if (!owner?.agreementAccepted) {
        const r = await fetch("/api/franchise/agreement", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: agreement.version }) });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? "The rules could not be accepted.");
      }
      const res = await fetch("/api/franchise/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ zoneIds: cart }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "The areas could not be reserved.");
      const pay = await fetch(`/api/franchise/bookings/${payload.booking.id}/pay`, { method: "POST" });
      const p = await pay.json().catch(() => null);
      if (!pay.ok) throw new Error(p?.error?.message ?? "The payment could not be started.");
      // The gateway's hosted page (an external URL) — or, with no redirect, the owner's page.
      window.location.href = p?.checkoutUrl ?? `/franchise/my?booking=${payload.booking.id}`;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
      setBusy(false);
    }
  }

  if (step === "summary" && amounts) {
    const chosen = cart.map((id) => zones.find((z) => z.zoneId === id)!).filter(Boolean);
    return (
      <Card className="space-y-4 p-4" data-testid="franchise-summary">
        <h2 className="text-lg font-bold text-ink-900">Summary</h2>
        <table className="min-w-full text-sm">
          <tbody>
            {chosen.map((z) => (
              <tr key={z.zoneId} className="border-b border-cream-100">
                <td className="py-1 pr-2 font-semibold">{z.zoneId}</td>
                <td className="py-1 pr-2">{z.name}</td>
                <td className="py-1 pr-2 text-ink-500">{z.clusterCode}</td>
                <td className="py-1 text-right">{rupees(fee!)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} className="py-1 pr-2 text-right">
                {rupees(fee!)} × {amounts.areaCount}
              </td>
              <td className="py-1 text-right">{rupees(amounts.basePaise)}</td>
            </tr>
            <tr>
              <td colSpan={3} className="py-1 pr-2 text-right">GST {amounts.gstRateBp / 100}%</td>
              <td className="py-1 text-right">{rupees(amounts.gstPaise)}</td>
            </tr>
            <tr className="font-bold">
              <td colSpan={3} className="py-1 pr-2 text-right">Total (100% upfront)</td>
              <td className="py-1 text-right" data-testid="franchise-total">
                {rupees(amounts.totalPaise)}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="text-sm text-ink-700">
          {offer.launch.open ? `Launch offer: ${offer.launch.placesLeft} of ${offer.launch.placesTotal} places left.` : "Post-launch terms."} Each area is valid for {offer.validityMonths} months from the verified payment, until 23:59:59 IST the day before the anniversary. The slots are held for {offer.holdMinutes} minutes while you pay.
        </p>
        <details className="rounded-lg border border-cream-200 p-3 text-sm text-ink-700" open>
          <summary className="cursor-pointer font-semibold">Responsibilities and rules (version {agreement.version})</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {agreement.text.map((line) => (
              <li key={line.slice(0, 40)}>{line}</li>
            ))}
          </ul>
        </details>
        <label className="flex items-start gap-2 text-sm text-ink-800">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} data-testid="franchise-accept" className="mt-1" />
          <span>I have read and accept the franchise responsibilities and rules (version {agreement.version}). The fee is non-refundable, subject to applicable law.</span>
        </label>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={reserveAndPay} disabled={busy || !accepted} data-testid="franchise-pay">
            {busy ? "Reserving…" : `Reserve and pay ${rupees(amounts.totalPaise)}`}
          </Button>
          <Button variant="secondary" onClick={() => setStep("choose")} disabled={busy}>
            Back to areas
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4 pb-24" data-testid="franchise-booking">
      {!canBook ? (
        <Alert tone="warning" title={offer.closedMessage ?? "Bookings are not open"}>
          You can still browse the areas. WhatsApp or call +91 91751 93009 to register your interest.
        </Alert>
      ) : null}
      {canBook && !signedIn ? <Alert tone="info">Sign in to reserve areas. You can browse without signing in.</Alert> : null}
      {canBook && signedIn && owner && owner.missing.length ? (
        <Alert tone="warning" title="Before you can pay">
          Complete: {owner.missing.join(", ")}. {owner.hasDealer ? "Open your dealer page to finish KYC, PAN and the bank check." : <a className="font-semibold underline" href="/dealer/apply">Apply free as a dealer first.</a>}
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Clusters">
        {[{ code: "ALL", name: "All", zones: zones.length } as { code: string; name: string; zones: number }, ...clusters].map((c) => (
          <button
            key={c.code}
            type="button"
            role="tab"
            aria-selected={cluster === c.code}
            onClick={() => setCluster(c.code)}
            className={`min-h-10 rounded-full border px-3 text-sm ${cluster === c.code ? "border-kesari-600 bg-kesari-600 text-white" : "border-cream-200 bg-white text-ink-700"}`}
            data-testid={`cluster-${c.code}`}
          >
            {c.code === "ALL" ? "All" : c.code} · {c.zones}
          </button>
        ))}
      </div>

      <Card className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <input className={inputClass} placeholder="Search zone, area, PIN, profile" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" data-testid="zone-search" />
        <select className={inputClass} value={availability} onChange={(e) => setAvailability(e.target.value as typeof availability)} aria-label="Availability">
          <option value="">Any availability</option>
          <option value="2">2 slots free</option>
          <option value="1">1 slot free</option>
          <option value="0">Fully booked</option>
        </select>
        <select className={inputClass} value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="Commercial profile">
          <option value="">Any commercial profile</option>
          {profiles.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select className={inputClass} value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)} aria-label="Original or split">
          <option value="">Original and split</option>
          <option value="ORIGINAL">Original zones</option>
          <option value="SPLIT">Split zones</option>
        </select>
        <input className={inputClass} inputMode="numeric" placeholder="Min ₹ Cr / year" value={minCr} onChange={(e) => setMinCr(e.target.value.replace(/\D/g, ""))} aria-label="Minimum annual business" />
        <input className={inputClass} inputMode="numeric" placeholder="Max ₹ Cr / year" value={maxCr} onChange={(e) => setMaxCr(e.target.value.replace(/\D/g, ""))} aria-label="Maximum annual business" />
        <select className={inputClass} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="annual">Annual business, high → low</option>
          <option value="shops">Shop count, high → low</option>
          <option value="zone">Zone ID</option>
        </select>
        <div className="flex gap-2">
          <Button variant={view === "list" ? "primary" : "secondary"} size="sm" onClick={() => setView("list")}>
            List
          </Button>
          <Button variant={view === "map" ? "primary" : "secondary"} size="sm" onClick={() => setView("map")} data-testid="zone-map-toggle">
            Map
          </Button>
        </div>
      </Card>

      <p className="text-sm text-ink-600" data-testid="zone-count">
        {shown.length} of {zones.length} areas
      </p>

      {view === "map" ? <ZoneMap zones={shown} cart={cart} onToggle={(id) => canBook && toggle(id)} /> : null}

      {view === "list" ? (
        <div className="grid gap-3 md:grid-cols-2">
          {shown.map((z) => (
            <ZoneCard key={z.zoneId} zone={z} fee={fee} months={offer.validityMonths} selected={cart.includes(z.zoneId)} canBook={canBook} onToggle={() => toggle(z.zoneId)} />
          ))}
        </div>
      ) : null}

      {cart.length ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-cream-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur" data-testid="franchise-cart">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-ink-900">
              {cart.length} area{cart.length === 1 ? "" : "s"} selected · {amounts ? `${rupees(amounts.basePaise)} + GST` : ""}
              <span className="ml-2 font-normal text-ink-500">{cart.join(", ")}</span>
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setCart([])}>
                Clear
              </Button>
              <Button size="sm" disabled={!signedIn || !canBook || !!owner?.missing.length} onClick={() => setStep("summary")} data-testid="franchise-continue">
                Continue
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ZoneCard({ zone: z, fee, months, selected, canBook, onToggle }: { zone: ZoneView; fee: number | null; months: number; selected: boolean; canBook: boolean; onToggle: () => void }) {
  return (
    <Card className={`space-y-2 p-3 ${selected ? "ring-2 ring-kesari-500" : ""}`} data-testid={`zone-card-${z.zoneId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-ink-900 px-2 py-0.5 text-sm font-bold text-white">{z.zoneId}</span>
        <span className="text-xs text-ink-500">
          {z.clusterCode} · {z.clusterName}
        </span>
        <Badge tone={BADGE_TONE[z.badge]}>{ZONE_BADGE_LABELS[z.badge]}</Badge>
      </div>
      <h3 className="font-semibold text-ink-900">{z.name}</h3>
      <p className="text-xs text-ink-600">
        PIN {z.pinCodes.join(", ")} · {z.commercialProfile} · {z.origin === "ORIGINAL" ? "Original" : `Split from Zone ${z.splitFromZone}`}
      </p>
      <p className="text-xl font-bold text-kesari-800">
        ₹{crore(z.annualCrHundredths)} Cr <span className="text-sm font-normal text-ink-600">est. annual area business</span>
      </p>
      <p className="text-sm text-ink-700">
        {z.estShops.toLocaleString("en-IN")} est. shops · ₹{z.gmvPerShopLakh} lakh / shop / month · ₹{crore(z.monthlyCrHundredths)} Cr a month
      </p>
      <p className="text-xs text-ink-500">{ESTIMATE_DISCLOSURE}</p>
      <p className="text-sm text-ink-700">
        {fee != null ? `${rupees(fee)} + GST` : "Fee: new terms coming soon"} · {months} months · max {z.maxOwners} owners · {z.status === "BOOKABLE" ? `${z.slotsFree} slot${z.slotsFree === 1 ? "" : "s"} available` : "not bookable yet"}
      </p>
      {z.bookable && canBook ? (
        <Button size="sm" variant={selected ? "secondary" : "primary"} onClick={onToggle} data-testid={`zone-select-${z.zoneId}`}>
          {selected ? "Remove" : "Select"}
        </Button>
      ) : null}
    </Card>
  );
}

/** Map view: approved boundaries coloured by availability (Google Maps, already configured on the site). */
function ZoneMap({ zones, cart, onToggle }: { zones: ZoneView[]; cart: string[]; onToggle: (zoneId: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(isMapsAvailable() ? null : "The map is not available on this site; use the list.");
  const visible = useMemo(() => new Map(zones.map((z) => [z.zoneId, z])), [zones]);
  useEffect(() => {
    if (!box.current || !isMapsAvailable()) return;
    let cancelled = false;
    const shapes: google.maps.Data.Feature[] = [];
    (async () => {
      try {
        await loadGoogleMaps();
        const geo = await (await fetch("/api/franchise/boundaries")).json();
        if (cancelled || !box.current) return;
        const map = new google.maps.Map(box.current, { center: { lat: 18.55, lng: 73.86 }, zoom: 11, mapTypeControl: false, streetViewControl: false });
        const features = map.data.addGeoJson(geo);
        shapes.push(...features);
        map.data.setStyle((f) => {
          const id = String(f.getProperty("zone_id"));
          const z = visible.get(id);
          const colour = z ? MAP_COLOUR[z.badge] : "#94a3b8";
          return { fillColor: colour, fillOpacity: cart.includes(id) ? 0.55 : z ? 0.25 : 0.05, strokeColor: colour, strokeWeight: cart.includes(id) ? 3 : 1, visible: !!z };
        });
        map.data.addListener("click", (e: google.maps.Data.MouseEvent) => onToggle(String(e.feature.getProperty("zone_id"))));
        if (!features.length) setProblem("No area boundaries are approved yet — areas show here once GoKesari approves them.");
      } catch {
        if (!cancelled) setProblem("The map could not be loaded; use the list.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, cart, onToggle]);
  return (
    <div className="space-y-2">
      {problem ? <Alert tone="info">{problem}</Alert> : null}
      <div ref={box} className="h-[420px] w-full rounded-xl border border-cream-200 bg-cream-50" aria-label="Map of Pune franchise areas" />
      <p className="text-xs text-ink-500">Green: 2 slots · amber: 1 slot · red: fully booked · grey: coming soon. Tap an area to select it.</p>
    </div>
  );
}
