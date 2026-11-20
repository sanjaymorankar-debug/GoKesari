"use client";

/**
 * GoKesari Health — medical equipment (owner brief §2.7): browse nearby verified stores, rent (period,
 * start, address, family member, prescription where needed; rent + deposit + delivery paid online), follow
 * the rental (delivery code, extend, return pickup, deposit refund), and the store's side (listings,
 * rentals board, dispatch, delivery with the customer's code, return, condition check and damages).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";
import { addDays, formatDateKey, istDateKey } from "@/lib/consult/time";
import type { RentalStatus } from "@/lib/health/constants";
import type { HealthEquipmentListing, HealthEquipmentMaster, HealthEquipmentStoreProfile } from "@/server/db/schema";
import type { EquipmentCard, ListingDetail, RentalView, StoreBoard } from "@/server/health/rentals";
import { amount, api, Chip, ist, Panel, rupees, Tile } from "./api";
import { useHealthLive } from "./live";

const card = "rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4";
const UNIT_WORD = { DAY: ["day", "days"], WEEK: ["week", "weeks"], MONTH: ["month", "months"] } as const;
const UNIT_DAYS = { DAY: 1, WEEK: 7, MONTH: 30 } as const;
type Unit = keyof typeof UNIT_WORD;

function rentLine(l: Pick<EquipmentCard, "rentDayPaise" | "rentWeekPaise" | "rentMonthPaise">): string {
  return [l.rentDayPaise ? `${rupees(l.rentDayPaise)}/day` : null, l.rentWeekPaise ? `${rupees(l.rentWeekPaise)}/week` : null, l.rentMonthPaise ? `${rupees(l.rentMonthPaise)}/month` : null].filter(Boolean).join(" · ");
}

function Photo({ url, name }: { url: string | null; name: string }) {
  if (!url) return <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-cream-100 text-3xl" aria-hidden>🦽</span>;
  // eslint-disable-next-line @next/next/no-img-element -- listing photos are store-entered URLs
  return <img src={url} alt={name} className="h-20 w-20 shrink-0 rounded-xl border-2 border-[var(--gk-line)] object-cover" />;
}

/* ------------------------------------------------------------ browse */

export function EquipmentBrowse({ initial }: { initial: { q?: string; patientId?: string; suggestionId?: string } }) {
  const [q, setQ] = useState(initial.q ?? "");
  const [query, setQuery] = useState(initial.q ?? "");
  const [category, setCategory] = useState("");
  const [rentOnly, setRentOnly] = useState(false);
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [data, setData] = useState<{ results: EquipmentCard[]; categories: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const p = new URLSearchParams();
    if (query.trim()) p.set("q", query.trim());
    if (category) p.set("category", category);
    if (rentOnly) p.set("rent", "1");
    if (origin) {
      p.set("lat", String(origin.lat));
      p.set("lng", String(origin.lng));
    }
    api<{ results: EquipmentCard[]; categories: string[] }>(`/api/health/equipment/search?${p.toString()}`)
      .then((r) => live && (setData(r), setError(null)))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [query, category, rentOnly, origin]);
  const nearMe = () => {
    if (!navigator.geolocation) return setGeoError("Location is not available on this device.");
    navigator.geolocation.getCurrentPosition(
      (p) => (setOrigin({ lat: p.coords.latitude, lng: p.coords.longitude }), setGeoError(null)),
      () => setGeoError("Allow location access to see stores that deliver to you."),
      { timeout: 10_000 },
    );
  };
  const carry = new URLSearchParams();
  if (initial.patientId) carry.set("patient", initial.patientId);
  if (initial.suggestionId) carry.set("suggestion", initial.suggestionId);
  return (
    <div className="flex flex-col gap-4" data-testid="equipment-browse">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q);
        }}
      >
        <input className={`${inputClass} min-w-0 flex-1`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Wheelchair, oxygen concentrator, hospital bed…" aria-label="Search equipment" data-testid="equipment-q" />
        <Button type="submit">Search</Button>
        <Button variant="secondary" onClick={nearMe} data-testid="equipment-near-me">
          📍 {origin ? "Near me (on)" : "Near me"}
        </Button>
      </form>
      {geoError ? <p className="text-xs text-red-700">{geoError}</p> : null}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        <Chip active={!category} onClick={() => setCategory("")}>
          All
        </Chip>
        {data?.categories.map((c) => (
          <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
            {c}
          </Chip>
        ))}
        <Chip active={rentOnly} onClick={() => setRentOnly(!rentOnly)} testId="equipment-rent-only">
          For rent only
        </Chip>
      </div>
      {initial.suggestionId ? <Alert tone="info">From your doctor&apos;s suggestion. Choose an item to rent; the suggestion will show as booked.</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!data ? <p className="text-sm text-ink-600">Loading…</p> : null}
      {data && !data.results.length ? <Alert tone="info">No verified store has that nearby yet. Try another word or turn off “Near me”.</Alert> : null}
      <div className="grid gap-3 md:grid-cols-2" data-testid="equipment-results">
        {data?.results.map((l) => (
          <div key={l.listingId} className={`${card} flex flex-col gap-2`} data-testid="equipment-result">
            <div className="flex gap-3">
              <Photo url={l.photoUrl} name={l.name} />
              <div className="min-w-0">
                <p className="font-extrabold text-ink-900">{l.name}</p>
                <p className="text-xs text-ink-600">
                  {l.store.name}
                  {l.store.distanceText ? ` · ${l.store.distanceText}` : l.store.area ? ` · ${l.store.area}` : ""}
                </p>
                {l.forRent ? <p className="text-sm font-bold text-ink-800">{rentLine(l)}</p> : null}
                {l.forRent ? <p className="text-xs text-ink-600">Deposit {amount(l.depositPaise)}{l.deliveryPaise ? ` · delivery ${amount(l.deliveryPaise)}` : " · free delivery"}{l.minRentDays > 1 ? ` · min ${l.minRentDays} days` : ""}</p> : null}
                {l.forSale && l.salePricePaise ? <p className="text-sm text-ink-800">Buy: {rupees(l.salePricePaise)}</p> : null}
                {l.rxRequired ? <span className="mt-1 inline-block rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-800">Needs a prescription</span> : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {l.forRent && l.stock > 0 ? (
                <Link href={`/health/equipment/${l.listingId}?${carry.toString()}`} className="inline-flex min-h-11 items-center rounded-lg bg-kesari-600 px-4 text-sm font-bold text-white" data-testid="equipment-rent">
                  Rent
                </Link>
              ) : l.forRent ? (
                <span className="text-sm text-ink-600">Out of stock for rent</span>
              ) : null}
              {l.buyUrl ? (
                <Link href={l.buyUrl} className="inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] px-4 text-sm font-bold">
                  Buy
                </Link>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ rent form */

interface RentContext {
  patients: { id: string; name: string; relation: string }[];
  addresses: { id: string; label: string | null; text: string }[];
  prescriptions: { id: string; rxNumber: string; patientId: string; issuedAt: string | Date }[];
  suggestions: { id: string; patientId: string; text: string; createdAt: string | Date }[];
  preselect: { suggestionId: string; patientId: string } | null;
}

export function RentForm({ listing: l, context, preselectPatientId, signedIn }: { listing: ListingDetail; context: RentContext | null; preselectPatientId?: string | null; signedIn: boolean }) {
  const router = useRouter();
  const units = (["DAY", "WEEK", "MONTH"] as Unit[]).filter((u) => (u === "DAY" ? l.rentDayPaise : u === "WEEK" ? l.rentWeekPaise : l.rentMonthPaise));
  const [unit, setUnit] = useState<Unit>(units.includes("WEEK") ? "WEEK" : units[0] ?? "DAY");
  const unitPrice = (unit === "DAY" ? l.rentDayPaise : unit === "WEEK" ? l.rentWeekPaise : l.rentMonthPaise) ?? 0;
  const minCount = Math.max(1, Math.ceil(l.minRentDays / UNIT_DAYS[unit]));
  const [count, setCount] = useState(minCount);
  const today = istDateKey(new Date());
  const [startDate, setStartDate] = useState(today);
  const [quantity, setQuantity] = useState(1);
  const [patientId, setPatientId] = useState(context?.preselect?.patientId ?? preselectPatientId ?? context?.patients[0]?.id ?? "");
  const [addressId, setAddressId] = useState(context?.addresses[0]?.id ?? "");
  const [rxChoice, setRxChoice] = useState<string>(context?.preselect ? `s:${context.preselect.suggestionId}` : "");
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keeps the count at the minimum for the chosen unit
    setCount((c) => Math.max(c, minCount));
  }, [minCount]);
  const rent = unitPrice * count * quantity;
  const deposit = l.depositPaise * quantity;
  const total = rent + deposit + l.deliveryPaise;
  const due = addDays(startDate, count * UNIT_DAYS[unit]);
  const rxOptions = useMemo(
    () => [
      ...(context?.suggestions ?? []).filter((s) => !patientId || s.patientId === patientId).map((s) => ({ key: `s:${s.id}`, label: `Doctor's suggestion: ${s.text}` })),
      ...(context?.prescriptions ?? []).filter((x) => !patientId || x.patientId === patientId).map((x) => ({ key: `p:${x.id}`, label: `Prescription ${x.rxNumber} (${ist(x.issuedAt, false)})` })),
    ],
    [context, patientId],
  );
  const submit = async () => {
    if (!signedIn) {
      router.push(`/signin?callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ rental: { id: string }; checkoutUrl: string | null }>("/api/health/equipment/rentals", {
        json: {
          listingId: l.listingId,
          periodUnit: unit,
          periodCount: count,
          startDate,
          quantity,
          addressId,
          patientId: patientId || null,
          suggestionId: rxChoice.startsWith("s:") ? rxChoice.slice(2) : null,
          prescriptionId: rxChoice.startsWith("p:") ? rxChoice.slice(2) : null,
          acceptTerms: accept ? true : undefined,
        },
      });
      if (r.checkoutUrl) window.location.href = r.checkoutUrl;
      else router.push(`/health/equipment/rentals/${r.rental.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not book the rental.");
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4" data-testid="rent-form">
      <section className={`${card} flex gap-3`}>
        <Photo url={l.photoUrl} name={l.name} />
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold text-ink-900">{l.name}</h1>
          <p className="text-sm text-ink-700">
            {l.store.name}
            {l.store.area ? ` · ${l.store.area}` : ""} · delivers within {l.store.deliveryRadiusKm} km
          </p>
          <p className="text-sm font-bold">{rentLine(l)}</p>
          {l.description ? <p className="mt-1 text-sm text-ink-700">{l.description}</p> : null}
          {l.buyUrl ? (
            <Link href={l.buyUrl} className="mt-1 inline-block text-sm font-bold text-kesari-800 underline">
              Buy it instead{l.salePricePaise ? ` (${rupees(l.salePricePaise)})` : ""}
            </Link>
          ) : null}
        </div>
      </section>
      {!l.bookable ? <Alert tone="warning">Not available for rent right now.</Alert> : null}
      <Panel title="Rent">
        <div className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="Rent per">
              <select className={inputClass} value={unit} onChange={(e) => setUnit(e.target.value as Unit)} data-testid="rent-unit">
                {units.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_WORD[u][0]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Number of ${UNIT_WORD[unit][1]}`} hint={l.minRentDays > 1 ? `At least ${l.minRentDays} days` : undefined}>
              <input className={inputClass} type="number" min={minCount} max={365} value={count} onChange={(e) => setCount(Math.max(minCount, Math.min(365, Number(e.target.value) || minCount)))} data-testid="rent-count" />
            </Field>
            <Field label="Start">
              <input className={inputClass} type="date" min={today} max={addDays(today, 60)} value={startDate} onChange={(e) => setStartDate(e.target.value || today)} data-testid="rent-start" />
            </Field>
            <Field label="Quantity">
              <input className={inputClass} type="number" min={1} max={Math.min(50, l.stock)} value={quantity} onChange={(e) => setQuantity(Math.max(1, Math.min(l.stock, Number(e.target.value) || 1)))} />
            </Field>
          </div>
          {context?.patients.length ? (
            <Field label="For">
              <select className={inputClass} value={patientId} onChange={(e) => (setPatientId(e.target.value), setRxChoice(""))} data-testid="rent-patient">
                {context.patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label={l.rxRequired ? "Doctor's prescription (required for this equipment)" : "Doctor's prescription or suggestion (optional)"}>
            <select className={inputClass} value={rxChoice} onChange={(e) => setRxChoice(e.target.value)} data-testid="rent-rx">
              <option value="">{l.rxRequired ? "Choose…" : "None"}</option>
              {rxOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          {l.rxRequired && !rxOptions.length ? <p className="text-xs text-amber-800">No prescription in your health record yet. Ask your doctor to prescribe it on GoKesari, or upload your paper prescription in My Health → Records.</p> : null}
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 font-bold text-ink-700">Deliver to</legend>
            {context?.addresses.map((a) => (
              <label key={a.id} className="flex items-start gap-2">
                <input type="radio" className="mt-1 h-5 w-5" name="rent-address" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                <span>
                  {a.label ? <strong>{a.label}: </strong> : null}
                  {a.text}
                </span>
              </label>
            ))}
            <Link href="/profile/addresses" className="text-xs font-bold text-kesari-800 underline">
              {context?.addresses.length ? "Add another address" : "Add a delivery address"}
            </Link>
          </fieldset>
          <div className="rounded-xl bg-cream-100 p-3 text-sm" data-testid="rent-total">
            <p className="flex justify-between">
              <span>Rent ({count} {UNIT_WORD[unit][count === 1 ? 0 : 1]} × {quantity})</span>
              <span>{amount(rent)}</span>
            </p>
            <p className="flex justify-between">
              <span>Refundable deposit</span>
              <span>{amount(deposit)}</span>
            </p>
            <p className="flex justify-between">
              <span>Delivery and installation</span>
              <span>{amount(l.deliveryPaise)}</span>
            </p>
            <p className="mt-1 flex justify-between border-t border-cream-200 pt-1 font-extrabold">
              <span>Pay now</span>
              <span>{amount(total)}</span>
            </p>
            <p className="mt-1 text-xs text-ink-600">
              {formatDateKey(startDate)} to {formatDateKey(due)}. The deposit comes back after the return, less any damage under the store&apos;s policy.
            </p>
          </div>
          {l.store.rentalTerms || l.store.damagePolicy ? (
            <details className="text-sm">
              <summary className="cursor-pointer font-bold">Rental terms and damage policy</summary>
              {l.store.rentalTerms ? <p className="mt-1 whitespace-pre-line">{l.store.rentalTerms}</p> : null}
              {l.store.damagePolicy ? <p className="mt-1 whitespace-pre-line">{l.store.damagePolicy}</p> : null}
            </details>
          ) : null}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={accept} onChange={(e) => setAccept(e.target.checked)} data-testid="rent-accept" />
            <span>I accept the store&apos;s rental terms and damage policy. I will give my delivery code only after checking the equipment.</span>
          </label>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button size="lg" onClick={submit} disabled={busy || !l.bookable || !accept || !addressId || (l.rxRequired && !rxChoice)} data-testid="rent-confirm">
            {!signedIn ? "Sign in to rent" : busy ? "Please wait…" : `Pay ${amount(total)} and rent`}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------ one rental (customer and store) */

export function RentalScreen({ rentalId }: { rentalId: string }) {
  const [v, setV] = useState<RentalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [extendCount, setExtendCount] = useState(1);
  const [pickupAt, setPickupAt] = useState("");
  const [condition, setCondition] = useState("");
  const [damage, setDamage] = useState("0");
  const [reason, setReason] = useState("");
  const [dispute, setDispute] = useState("");
  const load = useCallback(() => api<RentalView>(`/api/health/equipment/rentals/${rentalId}`).then(setV).catch((e) => setError(e.message)), [rentalId]);
  useEffect(() => {
    void load();
  }, [load]);
  useHealthLive((e) => e.subjectId === rentalId, () => void load(), 400);
  const act = async (json: Record<string, unknown>, done?: (r: Record<string, unknown>) => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Record<string, unknown>>(`/api/health/equipment/rentals/${rentalId}`, { json });
      if (typeof r.checkoutUrl === "string") {
        window.location.href = r.checkoutUrl;
        return;
      }
      done?.(r);
      setCode("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not do that.");
    } finally {
      setBusy(false);
    }
  };
  if (!v) return error ? <Alert tone="danger">{error}</Alert> : <p className="text-sm text-ink-600">Loading…</p>;
  const r = v.rental;
  const isStore = v.viewer === "STORE";
  const address = r.address as { text?: string; note?: string | null; recipientName?: string | null } | null;
  const pickupIso = () => (pickupAt ? new Date(`${pickupAt}:00+05:30`).toISOString() : null);
  return (
    <div className="flex flex-col gap-4" data-testid="rental-screen">
      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex gap-3">
            <Photo url={v.listing.photoUrl} name={r.itemName} />
            <div>
              <p className="text-xs font-bold uppercase text-ink-600">{r.rentalNumber}</p>
              <h1 className="text-xl font-extrabold text-ink-900">
                {r.itemName} × {r.quantity}
              </h1>
              <p className="text-sm text-ink-700">
                {r.periodText} · {formatDateKey(r.startDate)} to {formatDateKey(r.dueDate)}
              </p>
              <p className="text-xs text-ink-600">
                {isStore ? `${v.customer?.name ?? "Customer"}${v.patientName ? ` for ${v.patientName}` : ""}` : v.store.name}
                {v.prescriptionNumber ? ` · prescription ${v.prescriptionNumber}` : ""}
              </p>
            </div>
          </div>
          <span className="rounded-full border-2 border-kesari-300 bg-kesari-50 px-3 py-1 text-sm font-extrabold text-kesari-800" data-testid="rental-status">
            {r.statusLabel}
          </span>
        </div>
        {address?.text ? <p className="mt-2 text-sm">🏠 {address.text}{address.note ? ` (${address.note})` : ""}</p> : null}
        {isStore && v.customer?.phone ? (
          <a href={`tel:${v.customer.phone}`} className="mt-2 inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] px-3 text-sm font-bold">
            📞 Call the customer
          </a>
        ) : null}
        {!isStore && v.store.phone ? (
          <a href={`tel:${v.store.phone}`} className="mt-2 inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] px-3 text-sm font-bold">
            📞 Call {v.store.name}
          </a>
        ) : null}
      </section>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {v.deliveryCode ? (
        <section className="rounded-2xl border-2 border-kesari-400 bg-white p-4 text-center" data-testid="rental-code">
          <p className="text-sm font-bold text-ink-700">Delivery code — give it after you check the equipment</p>
          <p className="mt-1 font-mono text-4xl font-extrabold tracking-[0.4em] text-kesari-800">{v.deliveryCode}</p>
        </section>
      ) : null}

      <Panel title="Money">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt>Rent{r.extensions.length ? ` (incl. ${r.extensions.length} extension${r.extensions.length > 1 ? "s" : ""})` : ""}</dt>
          <dd className="text-right">{amount(r.rentPaise)}</dd>
          <dt>Deposit</dt>
          <dd className="text-right">{amount(r.depositPaise)}</dd>
          <dt>Delivery</dt>
          <dd className="text-right">{amount(r.deliveryPaise)}</dd>
          <dt className="font-bold">Paid</dt>
          <dd className="text-right font-bold">{amount(r.paidPaise)}</dd>
          {r.status === "CLOSED" ? (
            <>
              <dt>Damages kept</dt>
              <dd className="text-right">{amount(r.damagePaise)}</dd>
              <dt className="font-bold">Deposit refund</dt>
              <dd className="text-right font-bold">{amount(r.depositRefundPaise)}</dd>
            </>
          ) : null}
        </dl>
        {r.conditionNote && r.status === "CLOSED" ? <p className="mt-2 text-sm text-ink-700">Condition: {r.conditionNote}</p> : null}
        {v.refunds.length ? (
          <ul className="mt-2 text-xs text-ink-700" data-testid="rental-refunds">
            {v.refunds.map((x, i) => (
              <li key={i}>
                Refund {amount(x.amountPaise)} — {x.status === "SUCCESS" ? `credited ${ist(x.settledAt)}` : x.status === "PENDING" ? "on its way (5–7 working days)" : "failed; GoKesari will retry"}
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      {v.can.pay ? (
        <Button size="lg" onClick={() => act({ action: "pay" })} disabled={busy} data-testid="rental-pay">
          Pay {amount(r.totalPaise)}
        </Button>
      ) : null}

      {v.can.extend ? (
        <section className={card}>
          <h2 className="font-extrabold">Extend</h2>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label={`More ${UNIT_WORD[r.periodUnit as Unit]?.[1] ?? "periods"}`}>
              <input className={`${inputClass} w-28`} type="number" min={1} max={365} value={extendCount} onChange={(e) => setExtendCount(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} />
            </Field>
            <Button onClick={() => act({ action: "extend", periodCount: extendCount })} disabled={busy} data-testid="rental-extend">
              Pay {amount(v.bookedRatePaise * extendCount * r.quantity)} and extend to {formatDateKey(addDays(r.dueDate, extendCount * UNIT_DAYS[(r.periodUnit as Unit) ?? "DAY"]))}
            </Button>
          </div>
        </section>
      ) : null}

      {v.can.scheduleReturn ? (
        <section className={card}>
          <h2 className="font-extrabold">{r.status === "RETURN_SCHEDULED" ? `Return pickup: ${ist(r.returnPickupAt)}` : "Schedule the return pickup"}</h2>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="Pickup time (IST)">
              <input className={inputClass} type="datetime-local" value={pickupAt} onChange={(e) => setPickupAt(e.target.value)} data-testid="rental-pickup" />
            </Field>
            <Button variant="secondary" disabled={busy || !pickupAt} onClick={() => act({ action: "schedule-return", pickupAt: pickupIso() }, () => setNotice("Return pickup scheduled."))}>
              {r.status === "RETURN_SCHEDULED" ? "Change pickup" : "Schedule pickup"}
            </Button>
          </div>
        </section>
      ) : null}

      {isStore ? (
        <>
          {v.can.dispatch ? (
            <Button size="lg" onClick={() => act({ action: "dispatch" })} disabled={busy} data-testid="rental-dispatch">
              🚚 Out for delivery
            </Button>
          ) : null}
          {v.can.deliver ? (
            <section className={card}>
              <Field label="Delivered: the customer's 4-digit delivery code" hint={`${v.otpMaxAttempts - r.otpAttempts} tries left.`}>
                <input className={`${inputClass} w-40 font-mono text-2xl tracking-[0.3em]`} inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))} data-testid="rental-code-input" />
              </Field>
              <Button className="mt-2" size="lg" disabled={busy || code.length !== 4} onClick={() => act({ action: "deliver", code })} data-testid="rental-deliver">
                Mark delivered — start the rental
              </Button>
            </section>
          ) : null}
          {v.can.markReturned ? (
            <Button variant="secondary" onClick={() => act({ action: "returned" })} disabled={busy} data-testid="rental-returned">
              Picked up — returned to the store
            </Button>
          ) : null}
          {v.can.close ? (
            <section className={card} data-testid="rental-close">
              <h2 className="font-extrabold">Condition check and deposit refund</h2>
              <Field label="Condition of the equipment">
                <textarea className={inputClass} rows={2} value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="Good condition / scratches on armrest / …" />
              </Field>
              <Field label={`Damage charge (₹, at most the deposit ${amount(r.depositPaise)})`}>
                <input className={`${inputClass} w-40`} inputMode="decimal" value={damage} onChange={(e) => setDamage(e.target.value.replace(/[^\d.]/g, ""))} />
              </Field>
              <p className="mt-1 text-sm">Refund to the customer: <strong>{amount(Math.max(0, r.depositPaise - Math.round(Number(damage || 0) * 100)))}</strong></p>
              <Button className="mt-2" disabled={busy || condition.trim().length < 3} onClick={() => act({ action: "close", conditionNote: condition, damageRupees: Number(damage || 0) }, () => setNotice("Rental closed. The deposit refund is on its way to the customer."))}>
                Close rental and refund the deposit
              </Button>
            </section>
          ) : null}
        </>
      ) : null}

      {v.can.cancel ? (
        <details className={card}>
          <summary className="cursor-pointer text-sm font-bold">Cancel this rental</summary>
          <p className="mt-1 text-xs text-ink-600">Before delivery, everything paid is refunded in full.</p>
          {isStore ? (
            <Field label="Reason for the customer">
              <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          ) : null}
          <Button variant="danger" className="mt-2" disabled={busy || (isStore && reason.trim().length < 3)} onClick={() => act({ action: "cancel", reason: reason || null })}>
            Cancel rental
          </Button>
        </details>
      ) : null}

      {v.can.dispute ? (
        <details className={card}>
          <summary className="cursor-pointer text-sm font-bold">Report a problem</summary>
          <textarea className={`${inputClass} mt-2`} rows={3} value={dispute} onChange={(e) => setDispute(e.target.value)} placeholder="What went wrong?" />
          <Button className="mt-2" disabled={busy || dispute.trim().length < 10} onClick={() => act({ action: "dispute", reason: dispute }, (x) => setNotice(`Sent to GoKesari support. Ticket ${String(x.ticketNumber)}.`))}>
            Send to GoKesari support
          </Button>
        </details>
      ) : null}

      {v.store.rentalTerms || v.store.damagePolicy ? (
        <details className="text-sm">
          <summary className="cursor-pointer font-bold">Rental terms and damage policy</summary>
          {v.store.rentalTerms ? <p className="mt-1 whitespace-pre-line">{v.store.rentalTerms}</p> : null}
          {v.store.damagePolicy ? <p className="mt-1 whitespace-pre-line">{v.store.damagePolicy}</p> : null}
        </details>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ store board */

const BOARD_COLUMNS: { title: string; statuses: RentalStatus[] }[] = [
  { title: "To deliver", statuses: ["CONFIRMED", "OUT_FOR_DELIVERY"] },
  { title: "With customers", statuses: ["ACTIVE", "RETURN_SCHEDULED"] },
  { title: "Condition check", statuses: ["RETURNED"] },
  { title: "Closed and cancelled", statuses: ["CLOSED", "CANCELLED"] },
];

export function EquipmentStoreBoard({ shopId }: { shopId: string }) {
  const [data, setData] = useState<StoreBoard | null>(null);
  const [tab, setTab] = useState<"rentals" | "listings">("rentals");
  const [editing, setEditing] = useState<HealthEquipmentListing | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<StoreBoard>(`/api/health/equipment/store?shopId=${shopId}`).then(setData).catch((e) => setError(e.message)), [shopId]);
  useEffect(() => {
    void load();
  }, [load]);
  const status = useHealthLive((e) => e.name.startsWith("rental.") || e.name.startsWith("provider."), () => void load(), 400);
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!data) return <p className="text-sm text-ink-600">Loading…</p>;
  const verification = data.profile?.verification ?? "NONE";
  return (
    <div className="flex flex-col gap-4" data-testid="equipment-store-board">
      {verification !== "VERIFIED" ? (
        <Alert tone={verification === "REJECTED" ? "danger" : "warning"} title={verification === "REJECTED" ? "Changes needed" : "Not listed yet"}>
          {verification === "NONE" ? "Fill your store profile (rental terms, damage policy, delivery radius). " : verification === "REJECTED" ? `${data.profile?.verificationNote ?? ""} ` : "GoKesari is verifying your store. "}
          Patients see your equipment once GoKesari verifies the store.{" "}
          <Link href={`/shop/health/equipment/profile?shopId=${shopId}`} className="font-bold underline">
            Store profile
          </Link>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={tab === "rentals"} onClick={() => setTab("rentals")}>
          Rentals
        </Chip>
        <Chip active={tab === "listings"} onClick={() => setTab("listings")} testId="equipment-listings-tab">
          Listings ({data.listings.length})
        </Chip>
        <span className="ml-auto text-xs font-semibold text-ink-600" data-testid="health-live" data-status={status}>
          {status === "live" ? "● Live" : status === "connecting" ? "Connecting…" : "Offline"}
        </span>
      </div>
      {tab === "rentals" ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {BOARD_COLUMNS.map((c) => (
              <Tile key={c.title} label={c.title} value={c.statuses.reduce((n, s) => n + (data.counts[s] ?? 0), 0)} tone={c.title === "To deliver" ? "kesari" : c.title === "With customers" ? "teal" : c.title === "Condition check" ? "amber" : "ink"} />
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {BOARD_COLUMNS.map((c) => {
              const rows = data.rentals.filter((r) => (c.statuses as string[]).includes(r.status));
              return (
                <Panel key={c.title} title={c.title}>
                  {!rows.length ? <p className="text-sm text-ink-600">None.</p> : null}
                  <ul className="flex flex-col gap-2">
                    {rows.slice(0, c.title.startsWith("Closed") ? 20 : 100).map((r) => (
                      <li key={r.id}>
                        <Link href={`/shop/health/equipment/rentals/${r.id}`} className="block rounded-xl border-2 border-[var(--gk-line)] p-2 hover:border-kesari-400" data-testid="store-rental-row">
                          <span className="flex justify-between gap-2 text-sm font-extrabold">
                            <span>
                              {r.itemName} × {r.quantity}
                            </span>
                            <span className="text-xs font-bold text-ink-600">{r.statusLabel}</span>
                          </span>
                          <span className="block text-xs text-ink-700">
                            {r.rentalNumber} · {r.customerName ?? ""} · {r.periodText} · due {formatDateKey(r.dueDate)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Panel>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div>
            <Button onClick={() => setEditing("new")} data-testid="equipment-add-listing">
              + Add equipment
            </Button>
          </div>
          {editing ? <ListingForm shopId={shopId} master={data.master} products={data.shopProducts} listing={editing === "new" ? null : editing} onDone={() => (setEditing(null), void load())} /> : null}
          <ul className="flex flex-col gap-2">
            {data.listings.map((l) => (
              <li key={l.id} className={`${card} flex flex-wrap items-center justify-between gap-2`} data-testid="store-listing-row">
                <span>
                  <span className="block font-extrabold">
                    {l.name} {l.status === "INACTIVE" ? <span className="text-xs text-ink-500">(hidden)</span> : null}
                  </span>
                  <span className="block text-xs text-ink-700">
                    {l.forRent ? rentLine(l) : "Not for rent"}
                    {l.forSale && l.salePricePaise ? ` · sale ${rupees(l.salePricePaise)}` : ""} · deposit {amount(l.depositPaise)} · stock {l.stock}
                    {l.rxRequired ? " · prescription needed" : ""}
                  </span>
                </span>
                <Button variant="secondary" size="sm" onClick={() => setEditing(l)}>
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ListingForm({ shopId, master, products, listing, onDone }: { shopId: string; master: HealthEquipmentMaster[]; products: { id: string; name: string }[]; listing: HealthEquipmentListing | null; onDone: () => void }) {
  const r = (p: number | null | undefined) => (p == null ? "" : String(p / 100));
  const [masterId, setMasterId] = useState(listing?.masterId ?? "");
  const [name, setName] = useState(listing?.name ?? "");
  const [description, setDescription] = useState(listing?.description ?? "");
  const [photoUrl, setPhotoUrl] = useState(listing?.photoUrl ?? "");
  const [forRent, setForRent] = useState(listing?.forRent ?? true);
  const [day, setDay] = useState(r(listing?.rentDayPaise));
  const [week, setWeek] = useState(r(listing?.rentWeekPaise));
  const [month, setMonth] = useState(r(listing?.rentMonthPaise));
  const [minDays, setMinDays] = useState(listing?.minRentDays ?? 1);
  const [deposit, setDeposit] = useState(r(listing?.depositPaise ?? 0));
  const [delivery, setDelivery] = useState(r(listing?.deliveryPaise ?? 0));
  const [stock, setStock] = useState(listing?.stock ?? 1);
  const [forSale, setForSale] = useState(listing?.forSale ?? false);
  const [salePrice, setSalePrice] = useState(r(listing?.salePricePaise));
  const [productId, setProductId] = useState(listing?.shopProductId ?? "");
  const masterRow = master.find((m) => m.id === masterId);
  const [rx, setRx] = useState<boolean>(listing?.rxRequired ?? false);
  const [active, setActive] = useState(listing?.status !== "INACTIVE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/health/equipment/store?shopId=${shopId}`, {
        json: {
          action: "listing",
          id: listing?.id,
          masterId: masterId || null,
          name: name || null,
          description: description || null,
          photoUrl: photoUrl || null,
          forRent,
          rentDayRupees: num(day),
          rentWeekRupees: num(week),
          rentMonthRupees: num(month),
          minRentDays: minDays,
          depositRupees: num(deposit) ?? 0,
          deliveryRupees: num(delivery) ?? 0,
          stock,
          forSale,
          salePriceRupees: num(salePrice),
          shopProductId: productId || null,
          rxRequired: rx,
          status: active ? "ACTIVE" : "INACTIVE",
        },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };
  const money = "w-full";
  return (
    <section className={`${card} flex flex-col gap-3`} data-testid="equipment-listing-form">
      <h2 className="font-extrabold">{listing ? `Edit ${listing.name}` : "Add equipment"}</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="From the GoKesari list">
          <select
            className={inputClass}
            value={masterId}
            onChange={(e) => {
              setMasterId(e.target.value);
              const m = master.find((x) => x.id === e.target.value);
              if (m) {
                if (!name) setName(m.name);
                setRx(m.rxRequired);
              }
            }}
            data-testid="listing-master"
          >
            <option value="">Custom item</option>
            {master.map((m) => (
              <option key={m.id} value={m.id}>
                {m.category}: {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name shown to customers">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={masterRow?.name ?? ""} />
        </Field>
      </div>
      <Field label="Description (optional)">
        <textarea className={inputClass} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Photo URL (optional)">
        <input className={inputClass} value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="https://…" />
      </Field>
      <label className="flex items-center gap-2 text-sm font-bold">
        <input type="checkbox" className="h-5 w-5" checked={forRent} onChange={(e) => setForRent(e.target.checked)} /> For rent
      </label>
      {forRent ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Field label="Rent / day (₹)">
            <input className={`${inputClass} ${money}`} inputMode="decimal" value={day} onChange={(e) => setDay(e.target.value)} data-testid="listing-day" />
          </Field>
          <Field label="Rent / week (₹)">
            <input className={inputClass} inputMode="decimal" value={week} onChange={(e) => setWeek(e.target.value)} />
          </Field>
          <Field label="Rent / month (₹)">
            <input className={inputClass} inputMode="decimal" value={month} onChange={(e) => setMonth(e.target.value)} />
          </Field>
          <Field label="Minimum days">
            <input className={inputClass} type="number" min={1} max={365} value={minDays} onChange={(e) => setMinDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} />
          </Field>
          <Field label="Deposit (₹)">
            <input className={inputClass} inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} data-testid="listing-deposit" />
          </Field>
          <Field label="Delivery / installation (₹)">
            <input className={inputClass} inputMode="decimal" value={delivery} onChange={(e) => setDelivery(e.target.value)} />
          </Field>
          <Field label="Units available">
            <input className={inputClass} type="number" min={0} max={10000} value={stock} onChange={(e) => setStock(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-sm font-bold">
        <input type="checkbox" className="h-5 w-5" checked={forSale} onChange={(e) => setForSale(e.target.checked)} /> Also for sale
      </label>
      {forSale ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Sale price (₹)">
            <input className={inputClass} inputMode="decimal" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />
          </Field>
          <Field label="Your shop product (Buy opens it)" hint="Buying is a normal GoKesari order from your shop.">
            <select className={inputClass} value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">Not linked</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-5 w-5" checked={rx} onChange={(e) => setRx(e.target.checked)} /> Needs a doctor&apos;s prescription to rent
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-5 w-5" checked={active} onChange={(e) => setActive(e.target.checked)} /> Show to customers
      </label>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button onClick={save} disabled={busy} data-testid="listing-save">
          Save
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ store profile */

export function EquipmentStoreProfileForm({ shopId, profile }: { shopId: string; profile: HealthEquipmentStoreProfile | null }) {
  const [terms, setTerms] = useState(profile?.rentalTerms ?? "");
  const [damage, setDamage] = useState(profile?.damagePolicy ?? "");
  const [radius, setRadius] = useState(profile?.deliveryRadiusKm ?? 10);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [state, setState] = useState(profile);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ profile: HealthEquipmentStoreProfile }>(`/api/health/equipment/store?shopId=${shopId}`, { json: { action: "profile", rentalTerms: terms || null, damagePolicy: damage || null, deliveryRadiusKm: radius } });
      setState(r.profile);
      setMsg({ tone: "success", text: r.profile.verification === "VERIFIED" ? "Saved." : "Saved. GoKesari will verify your store; you will be told when patients can see it." });
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`${card} flex flex-col gap-3`} data-testid="equipment-store-profile">
      <p className="text-sm">
        Verification:{" "}
        <strong data-testid="equipment-store-verification">{state ? (state.verification === "VERIFIED" ? "Verified by GoKesari" : state.verification === "REJECTED" ? `Changes needed — ${state.verificationNote ?? ""}` : "Waiting for GoKesari") : "Not submitted"}</strong>
      </p>
      <Field label="Rental terms" hint="Payment, minimum period, late return, cleaning, what the customer must do.">
        <textarea className={inputClass} rows={4} maxLength={3000} value={terms} onChange={(e) => setTerms(e.target.value)} />
      </Field>
      <Field label="Damage policy" hint="How damage is judged and charged from the deposit (never more than the deposit).">
        <textarea className={inputClass} rows={3} maxLength={3000} value={damage} onChange={(e) => setDamage(e.target.value)} />
      </Field>
      <Field label="Delivery radius (km)">
        <input className={`${inputClass} w-32`} type="number" min={1} max={100} value={radius} onChange={(e) => setRadius(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
      </Field>
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
      <Button onClick={save} disabled={busy} data-testid="equipment-store-save">
        Save store profile
      </Button>
    </section>
  );
}
