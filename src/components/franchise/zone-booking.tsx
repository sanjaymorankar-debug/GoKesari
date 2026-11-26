"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";
import { ZONE_BADGE_LABELS, rupees, type ZoneBadge, type ZoneTier } from "@/lib/franchise";
import { isMapsAvailable, loadGoogleMaps } from "@/lib/geo/provider";
import type { OfferView } from "@/server/franchise/booking";
import { TierBadge, businessText } from "./zone-bits";
import type { ZoneView } from "@/server/franchise/zones";

const BADGE_TONE: Record<ZoneBadge, "success" | "warning" | "danger" | "neutral" | "info"> = {
  AVAILABLE: "success",
  ONE_LEFT: "warning",
  COMING_SOON: "info",
  RESERVED: "neutral",
  ON_HOLD: "neutral",
  SOLD_OUT: "danger",
  INACTIVE: "neutral",
};

export interface TierFacet {
  tier: ZoneTier;
  name: string;
  colour: string;
  count: number;
}

interface Props {
  zones: ZoneView[];
  facets: { regions: string[]; tiers: TierFacet[] };
  offer: OfferView;
  signedIn: boolean;
  dealerId: string | null;
  owner: { missing: string[]; kycMissing: string[]; agreementAccepted: boolean; hasDealer: boolean; hasPan: boolean } | null;
  agreement: { version: string; text: string[] };
  /** Current rates (basis points): free dealership one-time, franchise one-time and recurring. */
  rates: { freeSelfBp: number; freeOverrideBp: number; freeSecondBp: number; ownerSelfBp: number; ownerOverrideBp: number; ownerSecondBp: number; recurringBp: number };
  /** Days a paid buyer has to finish KYC after paying. */
  kycDays: number;
  /** Zones to start with (back from signing in: ?zones=…). */
  initialZones?: string[];
  initialJoin?: "free" | "paid" | null;
  /**
   * Onboarding v2 (/franchise/start, flag onboarding_v2): the model is already "paid franchise" — no free/paid step, a
   * subscription plan is mandatory, no buyer form (the dealer account comes from the shop), no 30-day KYC rule.
   */
  v2?: { plans: PlanOption[]; payoutMissing: string[] } | null;
  /** Onboarding v2 on, signed out (/franchise/book): "free dealer" signs in to /franchise/start instead of /dealer/apply. */
  v2Start?: boolean;
}

export interface PlanOption {
  id: string;
  name: string;
  description: string;
  label: string;
  durationMonths: number;
  isLaunchOffer: boolean;
}

const pct = (bp: number) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;

interface CartLine {
  zoneId: string;
  tier: ZoneTier;
  listPaise: number;
  discountPaise: number;
}

interface CartView {
  lines: CartLine[];
  problems: string[];
  coupon: { code: string; name: string } | null;
  listPaise: number;
  discountPaise: number;
  basePaise: number;
  gstRateBp: number;
  gstPaise: number;
  totalPaise: number;
  plan?: { id: string; name: string; durationMonths: number } | null;
}

/** Whether this signed-in dealer may put the zone in the cart now (the server checks again). */
function buyable(z: ZoneView, dealerId: string | null, allowProvisional: boolean): { ok: boolean; why: string | null } {
  if (z.status === "RESERVED") {
    if (!dealerId || z.reservedForDealerId !== dealerId) return { ok: false, why: "Reserved for another dealer" };
  } else if (z.status !== "AVAILABLE") return { ok: false, why: ZONE_BADGE_LABELS[z.badge] };
  if (z.slotsFree <= 0) return { ok: false, why: "Sold out" };
  if (z.feePaise == null) return { ok: false, why: "Fee not set yet" };
  if (z.provisional && z.promoFeePaise == null && !allowProvisional) return { ok: false, why: "Fees being finalised" };
  return { ok: true, why: null };
}

/**
 * Zone booking (final brief 21-Nov-2026 §5.5): a map coloured by tier and a list with region / tier / slots /
 * fee filters; select zones → the server-priced cart (fee, tier, coupon, GST, total) → rules (clickwrap) → reserve
 * (15-minute hold) and pay 100% online. Every amount shown comes from the server.
 */
export function ZoneBooking({ zones, facets, offer, signedIn, dealerId, owner, agreement, rates, kycDays, initialZones = [], initialJoin = null, v2 = null, v2Start = false }: Props) {
  const [region, setRegion] = useState("ALL");
  const [tier, setTier] = useState<ZoneTier | "ALL">("ALL");
  const [slots, setSlots] = useState<"any" | "available" | "1">("any");
  const [feeMin, setFeeMin] = useState("");
  const [feeMax, setFeeMax] = useState("");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"list" | "map">("list");
  const [cart, setCart] = useState<string[]>(initialZones);
  // Back from signing in with ?zones=…: straight to the payment summary (paid) or to the choice.
  const [step, setStep] = useState<"choose" | "join" | "summary">(initialZones.length ? (v2 || (initialJoin === "paid" && signedIn) ? "summary" : "join") : "choose");
  // v2: the plan is mandatory; with a single plan on offer it is chosen for the buyer.
  const [planId, setPlanId] = useState<string>(v2?.plans.length === 1 ? v2.plans[0].id : "");
  const [workZone, setWorkZone] = useState<string>(initialZones[0] ?? "");
  const [buyer, setBuyer] = useState({ name: "", mobile: "", pan: "" });
  const [coupon, setCoupon] = useState("");
  const [priced, setPriced] = useState<CartView | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(owner?.agreementAccepted ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tierFacet = useMemo(() => new Map(facets.tiers.map((t) => [t.tier, t])), [facets]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const min = feeMin ? Number(feeMin) * 100 : null;
    const max = feeMax ? Number(feeMax) * 100 : null;
    return zones.filter((z) => {
      if (region !== "ALL" && z.region !== region) return false;
      if (tier !== "ALL" && z.tier !== tier) return false;
      if (slots === "available" && !(z.status === "AVAILABLE" && z.slotsFree > 0)) return false;
      if (slots === "1" && z.slotsFree !== 1) return false;
      if (min != null && (z.feePaise ?? 0) < min) return false;
      if (max != null && (z.feePaise ?? Number.MAX_SAFE_INTEGER) > max) return false;
      if (needle && !`${z.zoneId} ${z.name} ${z.region} ${z.areas.join(" ")} ${z.reason}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [zones, region, tier, slots, feeMin, feeMax, q]);

  const canBook = offer.bookingOpen;
  const chosen = cart.map((id) => zones.find((z) => z.zoneId === id)).filter((z): z is ZoneView => !!z);
  const listPaise = chosen.reduce((s, z) => s + (z.feePaise ?? 0), 0);
  const toggle = (zoneId: string) => {
    setPriced(null);
    setCart((c) => (c.includes(zoneId) ? c.filter((z) => z !== zoneId) : [...c, zoneId]));
  };

  async function priceCart(code: string, plan: string = planId): Promise<CartView | null> {
    setCouponError(null);
    if (v2 && !plan) {
      setPriced(null);
      return null;
    }
    const res = await fetch("/api/franchise/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ zoneIds: cart, couponCode: code.trim() || null, ...(v2 ? { planId: plan } : {}) }) });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      setCouponError(payload?.error?.message ?? "The cart could not be priced.");
      return null;
    }
    setPriced(payload as CartView);
    return payload as CartView;
  }

  // Landing on the summary (back from signing in): price the cart once.
  const firstPricing = useRef(false);
  useEffect(() => {
    if (firstPricing.current || (initialJoin !== "paid" && !v2) || !signedIn || !initialZones.length || (v2 && !planId)) return;
    firstPricing.current = true;
    fetch("/api/franchise/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ zoneIds: initialZones, couponCode: null, ...(v2 ? { planId } : {}) }) })
      .then(async (res) => ({ ok: res.ok, payload: await res.json().catch(() => null) }))
      .then(({ ok, payload }) => (ok ? setPriced(payload as CartView) : setError(payload?.error?.message ?? "The cart could not be priced. Please try again.")))
      .catch(() => setError("The cart could not be priced. Please try again."));
  }, [initialJoin, signedIn, initialZones, v2, planId]);

  /** Where to send a signed-out visitor so he comes back to this choice. */
  const signInFor = (join: "free" | "paid") => `/signin?callbackUrl=${encodeURIComponent(`/franchise/book?zones=${cart.join(",")}&join=${join}`)}`;
  const freeHref = (zoneId: string) => {
    if (v2Start) return `/signin?callbackUrl=${encodeURIComponent("/franchise/start?model=free")}`;
    const apply = `/dealer/apply?zone=${encodeURIComponent(zoneId)}`;
    return signedIn ? apply : `/signin?callbackUrl=${encodeURIComponent(apply)}`;
  };
  const blocked = owner?.missing.filter((m) => m !== "PAN" && !m.startsWith("your name")) ?? [];

  async function openSummary() {
    setError(null);
    setStep("summary");
    if (v2 && !planId) return; // priced once a plan is chosen
    if (!(await priceCart(""))) setError("The cart could not be priced. Please try again.");
  }

  async function choosePlan(id: string) {
    setPlanId(id);
    setError(null);
    if (id && !(await priceCart(priced?.coupon?.code ?? coupon, id))) setError("The cart could not be priced with this plan. Please try again.");
  }

  async function applyCoupon() {
    setBusy(true);
    const res = await fetch("/api/franchise/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ zoneIds: cart, couponCode: coupon.trim(), ...(v2 ? { planId } : {}) }) });
    const payload = await res.json().catch(() => null);
    if (res.ok) {
      setCouponError(null);
      setPriced(payload as CartView);
    } else {
      // A rejected code leaves the cart at list prices; the server's message says why.
      setCouponError(payload?.error?.message ?? "The coupon could not be applied.");
    }
    setBusy(false);
  }

  async function reserveAndPay() {
    setBusy(true);
    setError(null);
    try {
      if (!accepted) throw new Error("Please read and accept the responsibilities and rules.");
      if (v2 && !planId) throw new Error("Choose a subscription plan.");
      // Pay first, KYC after (22-Nov-2026): a buyer without a dealer account (or PAN) gives name, mobile and PAN.
      // v2: the dealer account was made from the shop on /franchise/start — no form.
      if (!v2 && !owner?.hasPan) {
        const b = await fetch("/api/franchise/buyer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buyer) });
        const bp = await b.json().catch(() => null);
        if (!b.ok) {
          const fields = bp?.error?.details?.fields as Record<string, string> | undefined;
          throw new Error(fields ? Object.values(fields).join(" ") : (bp?.error?.message ?? "Your details could not be saved."));
        }
      }
      if (!owner?.agreementAccepted) {
        const r = await fetch("/api/franchise/agreement", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: agreement.version }) });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? "The rules could not be accepted.");
      }
      const res = await fetch("/api/franchise/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ zoneIds: cart, couponCode: priced?.coupon?.code ?? null, ...(v2 ? { planId } : {}) }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "The zones could not be reserved.");
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

  if (step === "summary") {
    return (
      <Card className="space-y-4 p-4" data-testid="franchise-summary">
        <h2 className="text-lg font-bold text-ink-900">Your cart</h2>
        {v2 ? (
          <fieldset className="space-y-2" data-testid="franchise-plans">
            <legend className="text-sm font-semibold text-ink-900">Subscription plan (required)</legend>
            {v2.plans.length ? null : <Alert tone="warning">No subscription plan is on offer right now. WhatsApp or call +91 91751 93009.</Alert>}
            <div className="grid gap-2 sm:grid-cols-2">
              {v2.plans.map((p) => (
                <label key={p.id} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${planId === p.id ? "border-kesari-600 bg-kesari-50" : "border-cream-200"}`}>
                  <input type="radio" name="plan" className="mt-1" checked={planId === p.id} onChange={() => void choosePlan(p.id)} disabled={busy} data-testid={`plan-${p.id}`} />
                  <span>
                    <span className="font-semibold text-ink-900">{p.name}</span>
                    {p.isLaunchOffer ? <span className="ml-2"><Badge tone="success">Launch offer</Badge></span> : null}
                    <span className="block text-ink-700">{p.label}</span>
                    {p.description ? <span className="block text-xs text-ink-500">{p.description}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-cream-200 text-left text-xs text-ink-500">
              <th className="py-1 pr-2">Zone</th>
              <th className="py-1 pr-2">Tier</th>
              <th className="py-1 pr-2 text-right">Annual fee</th>
              <th className="py-1 text-right">Coupon</th>
            </tr>
          </thead>
          <tbody>
            {chosen.map((z) => {
              const line = priced?.lines.find((l) => l.zoneId === z.zoneId);
              return (
                <tr key={z.zoneId} className="border-b border-cream-100">
                  <td className="py-1 pr-2">
                    <span className="font-semibold">{z.zoneId}</span> {z.name}
                  </td>
                  <td className="py-1 pr-2">{z.tierName ? <TierBadge name={z.tierName} colour={z.tierColour} /> : "—"}</td>
                  <td className="py-1 pr-2 text-right">{rupees(line?.listPaise ?? z.feePaise ?? 0)}</td>
                  <td className="py-1 text-right">{line?.discountPaise ? `− ${rupees(line.discountPaise)}` : "—"}</td>
                </tr>
              );
            })}
            {priced ? (
              <>
                <tr>
                  <td colSpan={3} className="py-1 pr-2 text-right">Zone fees</td>
                  <td className="py-1 text-right">{rupees(priced.listPaise)}</td>
                </tr>
                {priced.discountPaise ? (
                  <tr>
                    <td colSpan={3} className="py-1 pr-2 text-right">Coupon {priced.coupon?.code}</td>
                    <td className="py-1 text-right">− {rupees(priced.discountPaise)}</td>
                  </tr>
                ) : null}
                <tr>
                  <td colSpan={3} className="py-1 pr-2 text-right">Taxable amount</td>
                  <td className="py-1 text-right">{rupees(priced.basePaise)}</td>
                </tr>
                <tr>
                  <td colSpan={3} className="py-1 pr-2 text-right">GST {priced.gstRateBp / 100}%</td>
                  <td className="py-1 text-right">{rupees(priced.gstPaise)}</td>
                </tr>
                <tr className="font-bold">
                  <td colSpan={3} className="py-1 pr-2 text-right">Total (100% online, upfront)</td>
                  <td className="py-1 text-right" data-testid="franchise-total">
                    {rupees(priced.totalPaise)}
                  </td>
                </tr>
              </>
            ) : null}
          </tbody>
        </table>
        {priced?.problems.length ? <Alert tone="warning">{priced.problems.join("; ")}</Alert> : null}
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm text-ink-700">
            Coupon code (one per order)
            <input className={`${inputClass} mt-1 uppercase`} value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} maxLength={30} data-testid="franchise-coupon" />
          </label>
          <Button variant="secondary" size="sm" onClick={applyCoupon} disabled={busy || !coupon.trim()} data-testid="franchise-coupon-apply">
            Apply
          </Button>
          {priced?.coupon ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setCoupon("");
                void priceCart("");
              }}
              disabled={busy}
            >
              Remove coupon
            </Button>
          ) : null}
        </div>
        {couponError ? <Alert tone="danger">{couponError}</Alert> : null}
        {priced?.coupon ? <p className="text-sm text-green-800">Coupon {priced.coupon.code} applied — {priced.coupon.name}. The discount comes off the fee before GST.</p> : null}
        <p className="text-sm text-ink-700">
          {offer.launch.open ? `Launch offer for the first ${offer.launch.placesTotal} franchise dealers: ${offer.launch.placesLeft} places left.` : ""} Each franchise runs {priced?.plan?.durationMonths ?? offer.validityMonths} months from the verified payment, at the fee you pay now. Your slots are held for {offer.holdMinutes} minutes while you pay; zones are assigned only after the payment succeeds.
        </p>
        {!v2 && !owner?.hasPan ? (
          <div className="space-y-2 rounded-lg border border-cream-200 p-3" data-testid="franchise-buyer">
            <p className="text-sm font-semibold text-ink-900">Your details (for the receipt and your dealer account)</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="text-sm text-ink-700">
                Full name
                <input className={`${inputClass} mt-1`} value={buyer.name} onChange={(e) => setBuyer({ ...buyer, name: e.target.value })} autoComplete="name" maxLength={120} data-testid="buyer-name" />
              </label>
              <label className="text-sm text-ink-700">
                Mobile
                <input className={`${inputClass} mt-1`} value={buyer.mobile} onChange={(e) => setBuyer({ ...buyer, mobile: e.target.value.replace(/[^\d+ ]/g, "") })} inputMode="tel" autoComplete="tel" maxLength={14} placeholder="10 digits" data-testid="buyer-mobile" />
              </label>
              <label className="text-sm text-ink-700">
                PAN
                <input className={`${inputClass} mt-1 uppercase`} value={buyer.pan} onChange={(e) => setBuyer({ ...buyer, pan: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} maxLength={10} placeholder="ABCDE1234F" data-testid="buyer-pan" />
              </label>
            </div>
          </div>
        ) : null}
        {v2 ? (
          <Alert tone="info" title="Live as soon as you pay" data-testid="franchise-v2-live">
            Your franchise — zones, franchise code, your team&apos;s shops and commission — goes live the moment the payment succeeds. We use the verified details of your account and your shop.
            {v2.payoutMissing.length ? ` Before your first payout, add your ${v2.payoutMissing.join(" and ")} on your dealer page.` : ""}
          </Alert>
        ) : owner?.kycMissing.length !== 0 ? (
          <Alert tone="info" title="Pay now, finish KYC after">
            Your zones are booked for you as soon as the payment succeeds. Within {kycDays} days, finish your dealer KYC on <a className="font-semibold underline" href="/dealer/apply">your dealer page</a> (documents and bank account). Your franchise goes live — your franchise code, your team&apos;s shops and your commission — once GoKesari approves them. Not finished in {kycDays} days: GoKesari may refund the fee and free the zone.
          </Alert>
        ) : null}
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
          <Button onClick={reserveAndPay} disabled={busy || !accepted || !priced || !!priced.problems.length || (v2 ? !planId : !owner?.hasPan && (!buyer.name.trim() || !buyer.mobile.trim() || buyer.pan.length !== 10))} data-testid="franchise-pay">
            {busy ? "Please wait…" : priced ? `Reserve and pay ${rupees(priced.totalPaise)}` : v2 && !planId ? "Choose a plan" : "Pricing…"}
          </Button>
          <Button variant="secondary" onClick={() => setStep(v2 ? "choose" : "join")} disabled={busy}>
            Back
          </Button>
        </div>
      </Card>
    );
  }

  if (step === "join") {
    const chosenFee = chosen.reduce((sum, z) => sum + (z.feePaise ?? 0), 0);
    return (
      <div className="space-y-4" data-testid="franchise-join">
        <div>
          <h2 className="text-lg font-bold text-ink-900">How do you want to work in {chosen.length === 1 ? chosen[0].name : `these ${chosen.length} zones`}?</h2>
          <p className="text-sm text-ink-600">{chosen.map((z) => z.zoneId).join(", ")}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Card className="flex flex-col gap-3 p-4" data-testid="join-free">
            <div>
              <Badge tone="success">No fee</Badge>
              <h3 className="mt-2 text-lg font-bold text-ink-900">Free dealership</h3>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
              <li>Register shops in your zone and build a team.</li>
              <li>
                One-time commission on each shop&apos;s registration fee: <strong>{pct(rates.freeSelfBp)}</strong> on shops you register, <strong>{pct(rates.freeOverrideBp)}</strong> and <strong>{pct(rates.freeSecondBp)}</strong> on your team&apos;s shops.
              </li>
              <li>No zone ownership and no monthly share. If a franchise later owns the zone, you can join that franchise&apos;s team.</li>
            </ul>
            {chosen.length > 1 ? (
              <label className="text-sm text-ink-700">
                Your working zone
                <select className={`${inputClass} mt-1`} value={workZone || chosen[0].zoneId} onChange={(e) => setWorkZone(e.target.value)} data-testid="join-free-zone">
                  {chosen.map((z) => (
                    <option key={z.zoneId} value={z.zoneId}>
                      {z.zoneId} · {z.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <a className="mt-auto inline-flex min-h-10 items-center justify-center rounded-lg border border-kesari-600 px-4 text-sm font-semibold text-kesari-800 hover:bg-kesari-50" href={freeHref(chosen.some((z) => z.zoneId === workZone) ? workZone : chosen[0].zoneId)} data-testid="join-free-go">
              Apply free as a dealer
            </a>
          </Card>
          <Card className="flex flex-col gap-3 p-4 ring-2 ring-kesari-500" data-testid="join-paid">
            <div>
              <Badge tone="info">{offer.launch.open ? "Launch offer" : "Annual fee"}</Badge>
              <h3 className="mt-2 text-lg font-bold text-ink-900">Franchise (paid)</h3>
              <p className="text-xl font-bold text-kesari-800">
                {rupees(chosenFee)} <span className="text-sm font-normal text-ink-600">a year + GST for {chosen.length === 1 ? "this zone" : `${chosen.length} zones`}</span>
              </p>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
              <li>You own the zone (at most {offer.maxOwnersPerZone} franchises a zone) for {offer.validityMonths} months.</li>
              <li>
                One-time: <strong>{pct(rates.ownerSelfBp)}</strong> on shops you register yourself; <strong>{pct(rates.ownerOverrideBp)}</strong> / <strong>{pct(rates.ownerSecondBp)}</strong> on your team&apos;s shops.
              </li>
              <li>
                Every month: <strong>{pct(rates.recurringBp)}</strong> of GoKesari&apos;s commission on orders from your zone&apos;s shops.
              </li>
              <li>Pay online now; finish your KYC within {kycDays} days to go live.</li>
            </ul>
            {blocked.length ? <Alert tone="warning">This account cannot buy a franchise: {blocked.join(", ")}.</Alert> : null}
            {signedIn ? (
              <Button className="mt-auto" onClick={openSummary} disabled={!canBook || !!blocked.length} data-testid="join-paid-go">
                Continue to payment
              </Button>
            ) : (
              <a className="mt-auto inline-flex min-h-10 items-center justify-center rounded-lg bg-kesari-600 px-4 text-sm font-semibold text-white hover:bg-kesari-700" href={signInFor("paid")} data-testid="join-paid-signin">
                Sign in to pay
              </a>
            )}
          </Card>
        </div>
        <Button variant="secondary" onClick={() => setStep("choose")}>
          Back to zones
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-24" data-testid="franchise-booking">
      {!canBook ? (
        <Alert tone="warning" title={offer.closedMessage ?? "Bookings are not open"}>
          You can still browse the zones. WhatsApp or call +91 91751 93009 to register your interest.
        </Alert>
      ) : null}
      {canBook ? <Alert tone="info">{v2 ? "Select your zones, then choose your subscription plan and pay online — your franchise is live as soon as the payment succeeds." : "Select a zone, then choose: work in it free as a dealer, or own it as a franchise (pay online, KYC after)."}</Alert> : null}

      <div className="flex flex-wrap gap-2" aria-label="Tiers">
        {facets.tiers.map((t) => (
          <button
            key={t.tier}
            type="button"
            onClick={() => setTier(tier === t.tier ? "ALL" : t.tier)}
            className={`min-h-10 rounded-full border px-3 text-sm ${tier === t.tier ? "text-white" : "bg-white text-ink-700"}`}
            style={{ borderColor: t.colour, background: tier === t.tier ? t.colour : undefined }}
            data-testid={`tier-${t.tier}`}
          >
            {t.name} · {t.count}
          </button>
        ))}
      </div>

      <Card className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <input className={inputClass} placeholder="Search zone or area" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" data-testid="zone-search" />
        <select className={inputClass} value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region" data-testid="zone-region">
          <option value="ALL">All regions</option>
          {facets.regions.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <select className={inputClass} value={tier} onChange={(e) => setTier(e.target.value as ZoneTier | "ALL")} aria-label="Tier">
          <option value="ALL">All tiers</option>
          {facets.tiers.map((t) => (
            <option key={t.tier} value={t.tier}>
              {t.name}
            </option>
          ))}
        </select>
        <select className={inputClass} value={slots} onChange={(e) => setSlots(e.target.value as typeof slots)} aria-label="Slots">
          <option value="any">Any availability</option>
          <option value="available">Slots available now</option>
          <option value="1">1 slot left</option>
        </select>
        <input className={inputClass} inputMode="numeric" placeholder="Min fee ₹" value={feeMin} onChange={(e) => setFeeMin(e.target.value.replace(/\D/g, ""))} aria-label="Minimum annual fee" />
        <input className={inputClass} inputMode="numeric" placeholder="Max fee ₹" value={feeMax} onChange={(e) => setFeeMax(e.target.value.replace(/\D/g, ""))} aria-label="Maximum annual fee" />
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
        {shown.length} of {zones.length} zones · at most {offer.maxOwnersPerZone} franchises per zone
      </p>

      {view === "map" ? <ZoneMap zones={shown} cart={cart} onToggle={(id) => canBook && toggle(id)} tiers={facets.tiers} /> : null}

      {view === "list" ? (
        <div className="grid gap-3 md:grid-cols-2">
          {shown.map((z) => (
            <ZoneCard key={z.zoneId} zone={z} colour={z.tier ? (tierFacet.get(z.tier)?.colour ?? null) : null} selected={cart.includes(z.zoneId)} canBook={canBook} sale={buyable(z, dealerId, offer.allowProvisionalSale)} onToggle={() => toggle(z.zoneId)} />
          ))}
        </div>
      ) : null}

      {cart.length ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-cream-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur" data-testid="franchise-cart">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-ink-900">
              {cart.length} zone{cart.length === 1 ? "" : "s"} selected · {v2 ? "price with your plan on the next step" : `${rupees(listPaise)} + GST`}
              <span className="ml-2 font-normal text-ink-500">{cart.join(", ")}</span>
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setCart([])}>
                Clear
              </Button>
              <Button
                size="sm"
                disabled={!canBook}
                onClick={() => {
                  setWorkZone(cart[0]);
                  if (v2) void openSummary();
                  else setStep("join");
                }}
                data-testid="franchise-continue"
              >
                Continue
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ZoneCard({ zone: z, colour, selected, canBook, sale, onToggle }: { zone: ZoneView; colour: string | null; selected: boolean; canBook: boolean; sale: { ok: boolean; why: string | null }; onToggle: () => void }) {
  return (
    <Card className={`space-y-2 p-3 ${selected ? "ring-2 ring-kesari-500" : ""}`} data-testid={`zone-card-${z.zoneId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-ink-900 px-2 py-0.5 text-sm font-bold text-white">{z.zoneId}</span>
        {z.tierName ? <TierBadge name={z.tierName} colour={colour ?? z.tierColour} /> : null}
        {z.promoFeePaise != null ? <Badge tone="success">Launch offer</Badge> : null}
        {z.provisional ? <Badge tone="neutral">Provisional</Badge> : null}
        <Badge tone={BADGE_TONE[z.badge]}>{ZONE_BADGE_LABELS[z.badge]}</Badge>
      </div>
      <h3 className="font-semibold text-ink-900">
        <Link href={`/franchise/zones/${encodeURIComponent(z.zoneId)}`} className="hover:underline">
          {z.name}
        </Link>
        <span className="ml-2 text-xs font-normal text-ink-500">{z.region}</span>
      </h3>
      <p className="text-xl font-bold text-kesari-800" data-testid={`zone-fee-${z.zoneId}`}>
        {z.feePaise != null ? rupees(z.feePaise) : "—"} <span className="text-sm font-normal text-ink-600">a year + GST{z.promoFeePaise != null ? " · launch offer" : ""} · {z.vsAverage} vs {z.setName} average</span>
      </p>
      {z.promoFeePaise != null && z.regularFeePaise != null ? (
        <p className="text-xs text-ink-600" data-testid={`zone-regular-fee-${z.zoneId}`}>
          Regular rate after the launch offer: {rupees(z.regularFeePaise)} a year + GST{z.provisional ? " (provisional)" : ""}
        </p>
      ) : null}
      <p className="text-sm text-ink-700">{z.description}</p>
      <p className="text-xs text-ink-500">{businessText(z)}</p>
      <p className="text-xs text-ink-600">Areas: {z.areas.join(", ") || "—"}</p>
      <p className="text-sm text-ink-700">
        {z.slotsFree} of {z.maxOwners} slot{z.maxOwners === 1 ? "" : "s"} left
        {z.status === "RESERVED" && z.reservedUntil ? ` · reserved until ${new Date(z.reservedUntil).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}
      </p>
      {canBook ? (
        sale.ok || selected ? (
          <Button size="sm" variant={selected ? "secondary" : "primary"} onClick={onToggle} data-testid={`zone-select-${z.zoneId}`}>
            {selected ? "Remove" : "Select"}
          </Button>
        ) : (
          <p className="text-xs font-semibold text-ink-500">{sale.why}</p>
        )
      ) : null}
    </Card>
  );
}

/** Map view: each zone coloured by its tier — a drawn polygon, or a circle at the centre of its areas. */
function ZoneMap({ zones, cart, onToggle, tiers }: { zones: ZoneView[]; cart: string[]; onToggle: (zoneId: string) => void; tiers: TierFacet[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(isMapsAvailable() ? null : "The map is not available on this site; use the list.");
  const visible = useMemo(() => new Map(zones.map((z) => [z.zoneId, z])), [zones]);
  useEffect(() => {
    if (!box.current || !isMapsAvailable()) return;
    let cancelled = false;
    (async () => {
      try {
        await loadGoogleMaps();
        const geo = await (await fetch("/api/franchise/boundaries")).json();
        if (cancelled || !box.current) return;
        const map = new google.maps.Map(box.current, { center: { lat: 18.55, lng: 73.86 }, zoom: 11, mapTypeControl: false, streetViewControl: false });
        const features = (geo.features ?? []) as { geometry: { type: string; coordinates: unknown }; properties: { zone_id: string; colour: string | null } }[];
        let drawn = 0;
        for (const f of features) {
          const id = String(f.properties.zone_id);
          const z = visible.get(id);
          if (!z) continue;
          const colour = f.properties.colour ?? "#475569";
          const inCart = cart.includes(id);
          const style = { strokeColor: colour, strokeWeight: inCart ? 3 : 1, fillColor: colour, fillOpacity: inCart ? 0.6 : 0.3, map, clickable: true };
          let shape: google.maps.Circle | google.maps.Polygon;
          if (f.geometry.type === "Point") {
            const [lng, lat] = f.geometry.coordinates as [number, number];
            shape = new google.maps.Circle({ ...style, center: { lat, lng }, radius: 1500 });
          } else {
            const ring = (f.geometry.coordinates as [number, number][][])[0] ?? [];
            shape = new google.maps.Polygon({ ...style, paths: ring.map(([lng, lat]) => ({ lat, lng })) });
          }
          shape.addListener("click", () => onToggle(id));
          drawn++;
        }
        if (!drawn) setProblem("No zones to show on the map for these filters.");
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
      <div ref={box} className="h-[420px] w-full rounded-xl border border-cream-200 bg-cream-50" aria-label="Map of franchise zones" />
      <p className="text-xs text-ink-500">
        {tiers.map((t) => (
          <span key={t.tier} className="mr-3">
            <span className="mr-1 inline-block h-3 w-3 rounded-full align-middle" style={{ background: t.colour }} />
            {t.name}
          </span>
        ))}
        Tap a zone to select it.
      </p>
    </div>
  );
}
