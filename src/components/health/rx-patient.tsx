"use client";

/**
 * GoKesari Health "Get medicines", patient side (src/server/health/rx-orders.ts):
 *  - NewMedicineOrder: medicines and quantities → medical store → pickup or delivery → send
 *  - MedicineOrderView: status (live), the store's quote with a decision per substitute, pay, the pickup /
 *    delivery code, the bill, cancel, report a problem, send to another store
 */
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { RX_ORDER_STATUS_LABELS, type RxOrderStatus } from "@/lib/health/constants";
import { amount, api, ist } from "./api";
import { useHealthLive } from "./live";
import { BTN_PRIMARY, BTN_SECONDARY } from "./styles";

const inputCls = "min-h-11 w-full rounded-xl border-2 border-[var(--gk-line)] bg-white px-3 py-2 text-base text-ink-900 focus:border-kesari-500 focus:outline-none";
const BTN_DANGER = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border-2 border-red-300 bg-white px-4 py-2 text-sm font-extrabold text-red-800 hover:bg-red-50 disabled:opacity-60";

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
      {error}
    </p>
  );
}

function Box({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-base font-extrabold text-ink-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function RxStatusPill({ status }: { status: string }) {
  const tone =
    status === "COMPLETED"
      ? "border-leaf-300 bg-leaf-50 text-leaf-800"
      : ["DECLINED", "EXPIRED", "CANCELLED"].includes(status)
        ? "border-stone-300 bg-stone-50 text-stone-700"
        : status === "QUOTED"
          ? "border-amber-300 bg-amber-50 text-amber-900"
          : "border-teal-300 bg-teal-50 text-teal-900";
  return (
    <span className={clsx("inline-flex items-center rounded-full border-2 px-2 py-0.5 text-xs font-extrabold", tone)} data-testid="rx-status" data-status={status}>
      {RX_ORDER_STATUS_LABELS[status as RxOrderStatus] ?? status}
    </span>
  );
}

/* ------------------------------------------------------------ new order */

interface Item {
  id: string;
  lineNo: number;
  name: string;
  genericName: string;
  strength: string | null;
  form: string;
  dose: string;
  frequency: string;
  durationDays: number;
  quantity: number;
  dispensedQty: number;
  remaining: number;
  restricted: boolean;
  allowed: boolean;
  reason: string | null;
}

interface Store {
  shopId: string;
  name: string;
  area: string | null;
  city: string;
  address: string;
  distanceKm: number | null;
  open: boolean;
  ratingAvg: number | null;
  ratingCount: number;
  ownDelivery: boolean;
  deliveryRadiusKm: number;
  cashOnHandover: boolean;
  deliversToAddress: boolean | null;
  favourite: boolean;
}

interface Options {
  prescription: { id: string; rxNumber: string; version: number; issuedAt: string; validUntil: string | null; expired: boolean; doctor: string; clinic: string; patientName: string };
  items: Item[];
  stores: Store[];
  addresses: { id: string; label: string; text: string; hasLocation: boolean; isDefault: boolean }[];
  origin: { latitude: number; longitude: number; source: "DEVICE" | "ADDRESS" } | null;
  preselect: { prescriptionItemId: string; qty: number }[];
  responseMinutes: number;
}

const STEPS = ["Medicines", "Store", "Pickup or delivery", "Send"] as const;

export function NewMedicineOrder({ prescriptionId, fromOrderId }: { prescriptionId: string; fromOrderId?: string | null }) {
  const router = useRouter();
  const [opts, setOpts] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [shopId, setShopId] = useState<string | null>(null);
  const [fulfilment, setFulfilment] = useState<"PICKUP" | "DELIVERY">("PICKUP");
  const [addressId, setAddressId] = useState<string | null>(null);
  const [pickupAt, setPickupAt] = useState("");
  const [device, setDevice] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(false);

  const load = useCallback(
    async (extra: { latitude?: number; longitude?: number; addressId?: string | null } = {}, first = false) => {
      try {
        const p = new URLSearchParams({ prescriptionId });
        if (fromOrderId) p.set("fromOrderId", fromOrderId);
        if (extra.latitude != null && extra.longitude != null) {
          p.set("latitude", String(extra.latitude));
          p.set("longitude", String(extra.longitude));
        }
        if (extra.addressId) p.set("addressId", extra.addressId);
        const r = await api<Options>(`/api/health/rx-orders/options?${p.toString()}`);
        setOpts(r);
        if (first) {
          const init: Record<string, number> = {};
          if (r.preselect.length) for (const s of r.preselect) init[s.prescriptionItemId] = s.qty;
          else for (const i of r.items) if (i.allowed) init[i.id] = i.remaining;
          setPicked(init);
          const def = r.addresses.find((a) => a.isDefault) ?? r.addresses[0];
          if (def) setAddressId(def.id);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the prescription.");
      }
    },
    [prescriptionId, fromOrderId],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the inputs change
    void load({}, true);
  }, [load]);

  const locate = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("This device cannot share its location. Stores are sorted by your saved address instead.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const at = { latitude: Math.round(pos.coords.latitude * 1e5) / 1e5, longitude: Math.round(pos.coords.longitude * 1e5) / 1e5 };
        setDevice(at);
        setLocating(false);
        void load({ ...at, addressId: fulfilment === "DELIVERY" ? addressId : null });
      },
      () => {
        setLocating(false);
        setError("Location was not shared. Stores are sorted by your saved address instead.");
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  };

  const chosenItems = useMemo(() => Object.entries(picked).filter(([, q]) => q > 0), [picked]);
  const store = opts?.stores.find((s) => s.shopId === shopId) ?? null;

  if (error && !opts) return <ErrorNote error={error} />;
  if (!opts) return <p className="text-sm text-ink-600">Loading…</p>;
  const rx = opts.prescription;

  const chooseAddress = (id: string) => {
    setAddressId(id);
    void load({ ...(device ?? {}), addressId: id });
  };

  const send = async () => {
    if (!shopId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ order: { id: string } }>("/api/health/rx-orders", {
        json: {
          prescriptionId,
          shopId,
          items: chosenItems.map(([prescriptionItemId, qty]) => ({ prescriptionItemId, qty })),
          fulfilment,
          pickupAt: fulfilment === "PICKUP" && pickupAt ? new Date(pickupAt).toISOString() : null,
          addressId: fulfilment === "DELIVERY" ? addressId : null,
          latitude: device?.latitude ?? null,
          longitude: device?.longitude ?? null,
          fromOrderId: fromOrderId ?? null,
        },
      });
      router.push(`/health/medicines/${r.order.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the prescription.");
      setBusy(false);
    }
  };

  const favourites = opts.stores.filter((s) => s.favourite);
  const nearby = opts.stores.filter((s) => !s.favourite);

  return (
    <div className="flex flex-col gap-3" data-testid="rx-new">
      <div className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
        <p className="text-xs font-bold text-ink-600">
          Prescription {rx.rxNumber}
          {rx.version > 1 ? ` (v${rx.version})` : ""} · {ist(rx.issuedAt, false)}
        </p>
        <p className="font-extrabold text-ink-900">
          {rx.patientName} · {rx.doctor}
        </p>
        <p className="text-sm text-ink-700">
          {rx.clinic}
          {rx.validUntil ? ` · valid until ${ist(`${rx.validUntil}T12:00:00+05:30`, false)}` : ""}
        </p>
      </div>
      {rx.expired ? (
        <p className="rounded-xl border-2 border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">This prescription has expired. Ask your doctor for a new one.</p>
      ) : null}

      <ol className="flex gap-1 overflow-x-auto text-xs font-bold" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={clsx("shrink-0 rounded-full border-2 px-3 py-1", i === step ? "border-kesari-700 bg-kesari-700 text-white" : i < step ? "border-leaf-300 bg-leaf-50 text-leaf-800" : "border-[var(--gk-line)] bg-white text-ink-600")} aria-current={i === step ? "step" : undefined}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <ErrorNote error={error} />

      {step === 0 ? (
        <Box title="Which medicines?">
          <ul className="flex flex-col gap-2">
            {opts.items.map((i) => {
              const on = (picked[i.id] ?? 0) > 0;
              return (
                <li key={i.id} className={clsx("rounded-xl border-2 p-3", i.allowed ? "border-[var(--gk-line)]" : "border-dashed border-stone-300 bg-stone-50")}>
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-6 w-6 accent-kesari-700"
                      checked={on}
                      disabled={!i.allowed || rx.expired}
                      onChange={(e) => setPicked((p) => ({ ...p, [i.id]: e.target.checked ? i.remaining : 0 }))}
                      data-testid="rx-pick-item"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-extrabold text-ink-900">
                        {i.lineNo}. {i.name}
                      </span>
                      <span className="block text-sm text-ink-700">
                        {i.dose} · {i.frequency} · {i.durationDays} days · prescribed {i.quantity}
                        {i.dispensedQty ? `, ${i.dispensedQty} already supplied` : ""}
                      </span>
                      {i.reason ? <span className="block text-sm font-semibold text-amber-800">{i.reason}</span> : null}
                    </span>
                  </label>
                  {on ? (
                    <div className="mt-2 flex items-center gap-2 pl-9">
                      <span className="text-sm text-ink-700">Quantity</span>
                      <button type="button" className={BTN_SECONDARY} aria-label="Less" onClick={() => setPicked((p) => ({ ...p, [i.id]: Math.max(1, (p[i.id] ?? 1) - 1) }))}>
                        −
                      </button>
                      <input
                        className={clsx(inputCls, "w-20 text-center")}
                        inputMode="numeric"
                        value={picked[i.id]}
                        onChange={(e) => {
                          const n = Number(e.target.value.replace(/\D/g, "")) || 1;
                          setPicked((p) => ({ ...p, [i.id]: Math.min(i.remaining, Math.max(1, n)) }));
                        }}
                        aria-label={`Quantity of ${i.name}`}
                        data-testid="rx-pick-qty"
                      />
                      <button type="button" className={BTN_SECONDARY} aria-label="More" onClick={() => setPicked((p) => ({ ...p, [i.id]: Math.min(i.remaining, (p[i.id] ?? 0) + 1) }))}>
                        +
                      </button>
                      <span className="text-xs text-ink-600">max {i.remaining}</span>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex justify-end">
            <button type="button" className={BTN_PRIMARY} disabled={!chosenItems.length || rx.expired} onClick={() => setStep(1)} data-testid="rx-next-store">
              Choose a store
            </button>
          </div>
        </Box>
      ) : null}

      {step === 1 ? (
        <Box
          title="Choose a medical store"
          action={
            <button type="button" className={BTN_SECONDARY} onClick={locate} disabled={locating} data-testid="rx-locate">
              {locating ? "Locating…" : device ? "Location used" : "Use my location"}
            </button>
          }
        >
          <p className="mb-2 text-xs text-ink-600">
            {opts.origin ? (opts.origin.source === "DEVICE" ? "Nearest to where you are." : "Nearest to your saved address.") : "Share your location to see the nearest stores first."} Only GoKesari-verified stores (drug licence and pharmacist checked). The store replies within {opts.responseMinutes} minutes.
          </p>
          {!opts.stores.length ? <p className="text-sm text-ink-700">No verified medical store takes prescriptions near you yet.</p> : null}
          {favourites.length ? <h3 className="mb-1 mt-2 text-xs font-extrabold uppercase tracking-wide text-ink-600">Your stores</h3> : null}
          <StoreList stores={favourites} chosen={shopId} onChoose={setShopId} />
          {nearby.length ? <h3 className="mb-1 mt-3 text-xs font-extrabold uppercase tracking-wide text-ink-600">Nearby</h3> : null}
          <StoreList stores={nearby} chosen={shopId} onChoose={setShopId} />
          <div className="mt-3 flex justify-between gap-2">
            <button type="button" className={BTN_SECONDARY} onClick={() => setStep(0)}>
              Back
            </button>
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={!shopId}
              onClick={() => {
                if (store && !store.ownDelivery) setFulfilment("PICKUP");
                setStep(2);
              }}
              data-testid="rx-next-fulfilment"
            >
              Next
            </button>
          </div>
        </Box>
      ) : null}

      {step === 2 && store ? (
        <Box title="Pickup or delivery?">
          <div className="grid gap-2 sm:grid-cols-2">
            {(["PICKUP", "DELIVERY"] as const).map((f) => (
              <label key={f} className={clsx("flex min-h-11 cursor-pointer items-start gap-2 rounded-xl border-2 p-3", fulfilment === f ? "border-kesari-700 bg-kesari-50" : "border-[var(--gk-line)]", f === "DELIVERY" && !store.ownDelivery && "cursor-not-allowed opacity-60")}>
                <input type="radio" name="fulfilment" className="mt-1 h-5 w-5 accent-kesari-700" checked={fulfilment === f} disabled={f === "DELIVERY" && !store.ownDelivery} onChange={() => setFulfilment(f)} data-testid={`rx-fulfilment-${f.toLowerCase()}`} />
                <span>
                  <span className="block font-extrabold text-ink-900">{f === "PICKUP" ? "I will collect it" : "Deliver to my address"}</span>
                  <span className="block text-sm text-ink-700">{f === "PICKUP" ? `At ${store.name}, ${store.area ?? store.city}.` : store.ownDelivery ? `By the store's own delivery person, within ${store.deliveryRadiusKm} km.` : "This store does not deliver."}</span>
                </span>
              </label>
            ))}
          </div>
          {fulfilment === "PICKUP" ? (
            <label className="mt-3 block">
              <span className="mb-1 block text-sm font-bold text-ink-800">Preferred pickup time (optional)</span>
              <input type="datetime-local" className={inputCls} value={pickupAt} onChange={(e) => setPickupAt(e.target.value)} data-testid="rx-pickup-at" />
            </label>
          ) : (
            <div className="mt-3">
              <p className="mb-1 text-sm font-bold text-ink-800">Deliver to</p>
              {opts.addresses.length ? (
                <ul className="flex flex-col gap-2">
                  {opts.addresses.map((a) => (
                    <li key={a.id}>
                      <label className={clsx("flex min-h-11 cursor-pointer items-start gap-2 rounded-xl border-2 p-3", addressId === a.id ? "border-kesari-700 bg-kesari-50" : "border-[var(--gk-line)]")}>
                        <input type="radio" name="address" className="mt-1 h-5 w-5 accent-kesari-700" checked={addressId === a.id} onChange={() => chooseAddress(a.id)} data-testid="rx-address" />
                        <span>
                          <span className="block font-extrabold text-ink-900">{a.label}</span>
                          <span className="block text-sm text-ink-700">{a.text}</span>
                          {!a.hasLocation ? <span className="block text-xs font-semibold text-amber-800">No map pin: only a store in the same PIN code can confirm delivery.</span> : null}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-700">No saved address yet.</p>
              )}
              <Link href="/profile/addresses" className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-kesari-800 underline">
                Add or edit addresses
              </Link>
              {store.deliversToAddress === false && addressId ? <p className="mt-1 text-sm font-bold text-red-800">{store.name} does not deliver to this address. Choose pickup or another store.</p> : null}
              <p className="mt-2 text-xs text-ink-600">The store delivers with its own staff. GoKesari rider delivery for medicines comes in phase 2.</p>
            </div>
          )}
          <div className="mt-3 flex justify-between gap-2">
            <button type="button" className={BTN_SECONDARY} onClick={() => setStep(1)}>
              Back
            </button>
            <button type="button" className={BTN_PRIMARY} disabled={fulfilment === "DELIVERY" && (!addressId || store.deliversToAddress === false)} onClick={() => setStep(3)} data-testid="rx-next-review">
              Review
            </button>
          </div>
        </Box>
      ) : null}

      {step === 3 && store ? (
        <Box title="Send to the store">
          <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-sm">
            <dt className="text-ink-600">Store</dt>
            <dd className="font-bold text-ink-900">
              {store.name}
              {store.distanceKm != null ? ` · ${store.distanceKm} km` : ""}
            </dd>
            <dt className="text-ink-600">Medicines</dt>
            <dd>
              {chosenItems.map(([id, q]) => {
                const it = opts.items.find((i) => i.id === id);
                return (
                  <span key={id} className="block">
                    {it?.name} × {q}
                  </span>
                );
              })}
            </dd>
            <dt className="text-ink-600">How</dt>
            <dd>{fulfilment === "PICKUP" ? `Pickup${pickupAt ? `, around ${ist(new Date(pickupAt))}` : ""}` : `Delivery to ${opts.addresses.find((a) => a.id === addressId)?.text ?? ""}`}</dd>
          </dl>
          <p className="mt-2 text-xs text-ink-600">
            The store sees this prescription only (your access log shows it). It has {opts.responseMinutes} minutes to send a price; you approve before paying. If it does not reply, you can send it to another store.
          </p>
          <div className="mt-3 flex justify-between gap-2">
            <button type="button" className={BTN_SECONDARY} onClick={() => setStep(2)} disabled={busy}>
              Back
            </button>
            <button type="button" className={BTN_PRIMARY} onClick={send} disabled={busy} data-testid="rx-send">
              {busy ? "Sending…" : "Send prescription"}
            </button>
          </div>
        </Box>
      ) : null}
    </div>
  );
}

function StoreList({ stores, chosen, onChoose }: { stores: Store[]; chosen: string | null; onChoose: (id: string) => void }) {
  if (!stores.length) return null;
  return (
    <ul className="flex flex-col gap-2">
      {stores.map((s) => (
        <li key={s.shopId}>
          <button
            type="button"
            onClick={() => onChoose(s.shopId)}
            aria-pressed={chosen === s.shopId}
            className={clsx("flex min-h-11 w-full flex-col items-start rounded-xl border-2 p-3 text-left", chosen === s.shopId ? "border-kesari-700 bg-kesari-50" : "border-[var(--gk-line)] bg-white hover:border-kesari-400")}
            data-testid="rx-store"
          >
            <span className="flex w-full flex-wrap items-center justify-between gap-2">
              <span className="font-extrabold text-ink-900">{s.name}</span>
              <span className={clsx("rounded-full px-2 py-0.5 text-xs font-extrabold", s.open ? "bg-leaf-50 text-leaf-800" : "bg-stone-100 text-stone-700")}>{s.open ? "Open now" : "Closed now"}</span>
            </span>
            <span className="text-sm text-ink-700">
              {[s.area, s.city].filter(Boolean).join(", ")}
              {s.distanceKm != null ? ` · ${s.distanceKm < 1 ? `${Math.round(s.distanceKm * 1000)} m` : `${s.distanceKm.toFixed(1)} km`}` : ""}
            </span>
            <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs font-semibold text-ink-600">
              {s.ratingAvg != null ? <span className="text-amber-700">★ {s.ratingAvg.toFixed(1)} ({s.ratingCount})</span> : <span>New on GoKesari</span>}
              <span>{s.ownDelivery ? `Delivers within ${s.deliveryRadiusKm} km` : "Pickup only"}</span>
              <span>{s.cashOnHandover ? "Cash or online" : "Online payment only"}</span>
              {s.deliversToAddress === false ? <span className="text-red-800">Not to your address</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------ one order (patient) */

interface Line {
  id: string;
  name: string;
  genericName: string;
  strength: string | null;
  dose: string;
  frequency: string;
  durationDays: number;
  prescribedQty: number;
  alreadyDispensed: number;
  requestedQty: number;
  availability: string | null;
  quotedQty: number;
  substituteName: string | null;
  substituteGeneric: string | null;
  substituteStrength: string | null;
  substituteApproved: boolean | null;
  unitPricePaise: number;
  discountPaise: number;
  lineTotalPaise: number;
  batchNumber: string | null;
  expiryDate: string | null;
  dispensedQty: number;
}

export interface RxDetail {
  viewer: "PATIENT" | "STORE";
  order: {
    id: string;
    orderNumber: string;
    status: string;
    statusLabel: string;
    secondsLeft: number;
    fulfilment: "PICKUP" | "DELIVERY";
    pickupAt: string | null;
    address: Record<string, string | null> | null;
    distanceKm: number | null;
    expiresAt: string;
    createdAt: string;
    quotedAt: string | null;
    declineReason: string | null;
    cancelReason: string | null;
    goodsPaise: number;
    discountPaise: number;
    deliveryPaise: number;
    totalPaise: number;
    paymentMode: string | null;
    paymentStatus: string;
    paidOnlinePaise: number;
    paidOfflinePaise: number;
    refundPaise: number;
    commissionPaise: number;
    deliveryPerson: string | null;
    deliveryPhone: string | null;
    billNumber: string | null;
    completedAt: string | null;
    prescriptionId: string;
    patientId: string;
  };
  lines: Line[];
  store: { id: string; name: string; address: string; phone: string | null; latitude: number | null; longitude: number | null; cashOnHandover: boolean; ownDelivery: boolean; drugLicence: string | null; pharmacist: string | null };
  patient: { id: string; name: string; age: string | null; gender: string | null };
  prescription: { id: string; rxNumber: string; version: number; status: string; issuedAt: string; validUntil: string | null; doctor: string; registration: string; council: string; clinic: string } | null;
  checks: { doctorVerified: boolean; qrValid: boolean; qrStatus: string; withinValidity: boolean; itemsAllowedOnline: boolean; notes: string[] } | null;
  code: string | null;
  otpTriesLeft: number;
  refund: { requestedPaise: number; settledPaise: number; status: string };
  billDocumentId: string | null;
  can: Record<"quote" | "decline" | "pack" | "ready" | "dispatch" | "complete" | "storeCancel" | "approve" | "pay" | "cancel" | "newCode" | "report" | "sendElsewhere", boolean>;
}

export function addressLine(a: Record<string, string | null> | null): string {
  if (!a) return "";
  return [a.line1, a.line2, a.area, a.landmark ? `near ${a.landmark}` : null, a.city, a.pincode].filter(Boolean).join(", ");
}

export function Countdown({ seconds, onZero }: { seconds: number; onZero?: () => void }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restart the countdown when the server's figure changes
    setLeft(seconds);
    if (seconds <= 0) return;
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);
  useEffect(() => {
    if (left === 0 && seconds > 0) onZero?.();
  }, [left, seconds, onZero]);
  return (
    <span className="tabular-nums" data-testid="rx-countdown">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </span>
  );
}

export function MedicineOrderView({ orderId }: { orderId: string }) {
  const [d, setD] = useState<RxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [subs, setSubs] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<"ONLINE" | "CASH_ON_HANDOVER">("ONLINE");
  const [open, setOpen] = useState<null | "cancel" | "problem">(null);
  const [text, setText] = useState("");

  const load = useCallback(async () => {
    try {
      setD(await api<RxDetail>(`/api/health/rx-orders/${orderId}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the order.");
    }
  }, [orderId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system)
    void load();
  }, [load]);
  const live = useHealthLive((e) => e.subjectId === orderId, () => void load());

  const act = async (action: string, extra: Record<string, unknown> = {}, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ checkoutUrl?: string | null; ticketNumber?: string }>(`/api/health/rx-orders/${orderId}`, { json: { action, ...extra } });
      if (r.checkoutUrl) {
        window.location.href = r.checkoutUrl;
        return;
      }
      setOpen(null);
      setText("");
      setNotice(r.ticketNumber ? `Ticket ${r.ticketNumber} opened. GoKesari support will contact you.` : (done ?? null));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  if (error && !d) return <ErrorNote error={error} />;
  if (!d) return <p className="text-sm text-ink-600">Loading…</p>;
  const o = d.order;
  const subLines = d.lines.filter((l) => l.availability === "SUBSTITUTE" && l.substituteApproved === null);
  const preview = d.lines.reduce((n, l) => {
    if (l.quotedQty <= 0) return n;
    if (l.availability === "SUBSTITUTE" && l.substituteApproved === null && subs[l.id] === false) return n;
    return n + l.lineTotalPaise;
  }, 0) + (d.lines.some((l) => l.quotedQty > 0) ? o.deliveryPaise : 0);
  const allDecided = subLines.every((l) => typeof subs[l.id] === "boolean");

  return (
    <div className="flex flex-col gap-3" data-testid="rx-order-view">
      <div className="flex flex-wrap items-start justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
        <div>
          <p className="text-xs font-bold text-ink-600">
            {o.orderNumber} · {o.fulfilment === "PICKUP" ? "Pickup" : "Delivery"} · sent {ist(o.createdAt)}
          </p>
          <h2 className="text-lg font-extrabold text-ink-900">{d.store.name}</h2>
          <p className="text-sm text-ink-700">For {d.patient.name}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <RxStatusPill status={o.status} />
          <span className="text-xs text-ink-500" data-testid="health-live" data-status={live}>
            {live === "live" ? "Live" : live === "connecting" ? "Connecting…" : "Offline"}
          </span>
        </div>
      </div>
      {notice ? <p className="rounded-xl border-2 border-leaf-300 bg-leaf-50 px-3 py-2 text-sm font-semibold text-leaf-800">{notice}</p> : null}
      <ErrorNote error={error} />

      {o.status === "SENT" ? (
        <p className="rounded-xl border-2 border-teal-300 bg-teal-50 px-3 py-2 text-sm font-bold text-teal-900">
          Waiting for {d.store.name} to reply: <Countdown seconds={o.secondsLeft} onZero={() => void load()} /> left. You will be told the moment it replies.
        </p>
      ) : null}
      {["EXPIRED", "DECLINED", "CANCELLED"].includes(o.status) ? (
        <div className="rounded-xl border-2 border-stone-300 bg-stone-50 p-3 text-sm text-stone-800">
          <p className="font-bold">
            {o.status === "EXPIRED" ? `${d.store.name} did not reply in time.` : o.status === "DECLINED" ? `${d.store.name} declined: ${o.declineReason ?? ""}` : `Cancelled. ${o.cancelReason ?? ""}`}
          </p>
          {d.can.sendElsewhere ? (
            <Link href={`/health/medicines/new?prescription=${o.prescriptionId}&from=${o.id}`} className={clsx(BTN_PRIMARY, "mt-2")} data-testid="rx-send-elsewhere">
              Send to another store
            </Link>
          ) : null}
        </div>
      ) : null}

      {d.code ? (
        <div className="rounded-2xl border-2 border-teal-400 bg-teal-50 p-4 text-center" data-testid="rx-handover-code">
          <p className="text-sm font-bold text-teal-900">Your {o.fulfilment === "PICKUP" ? "pickup" : "delivery"} code</p>
          <p className="text-4xl font-extrabold tracking-[0.3em] text-teal-950">{d.code}</p>
          <p className="text-xs text-teal-900">
            {o.fulfilment === "PICKUP" ? "Tell this code at the counter when you collect the medicines." : "Tell this code to the delivery person only after you have the medicines."}
            {o.paymentMode === "CASH_ON_HANDOVER" ? ` Pay ${amount(o.totalPaise)} at handover.` : ""}
          </p>
          {d.can.newCode ? (
            <button type="button" className={clsx(BTN_SECONDARY, "mt-2")} onClick={() => act("newcode", {}, "A new code is shown.")} disabled={busy}>
              New code
            </button>
          ) : null}
        </div>
      ) : null}

      {o.status === "OUT_FOR_DELIVERY" && o.deliveryPerson ? (
        <p className="rounded-xl border-2 border-[var(--gk-line)] bg-white px-3 py-2 text-sm">
          On the way with <span className="font-bold">{o.deliveryPerson}</span>
          {o.deliveryPhone ? (
            <>
              {" "}
              ·{" "}
              <a href={`tel:${o.deliveryPhone}`} className="font-bold text-kesari-800 underline">
                {o.deliveryPhone}
              </a>
            </>
          ) : null}{" "}
          (the store&apos;s own delivery person).
        </p>
      ) : null}

      <Box title={o.status === "QUOTED" ? "The store's quote" : "Medicines"}>
        <ul className="flex flex-col gap-2">
          {d.lines.map((l) => (
            <li key={l.id} className="rounded-xl border-2 border-[var(--gk-line)] p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-extrabold text-ink-900">{l.availability === "SUBSTITUTE" && l.substituteName ? `${l.substituteName} (instead of ${l.name})` : l.name}</p>
                  <p className="text-xs text-ink-600">
                    Asked {l.requestedQty}
                    {l.availability ? ` · ${l.availability === "AVAILABLE" ? "available" : l.availability === "PARTIAL" ? `only ${l.quotedQty} available` : l.availability === "UNAVAILABLE" ? "not available" : `substitute, same ${l.genericName}${l.strength ? ` ${l.strength}` : ""}`}` : ""}
                    {l.dispensedQty ? ` · supplied ${l.dispensedQty}${l.batchNumber ? `, batch ${l.batchNumber}, exp ${l.expiryDate}` : ""}` : ""}
                  </p>
                </div>
                {l.quotedQty > 0 ? <p className="text-right text-sm font-bold tabular-nums">{amount(l.lineTotalPaise)}</p> : l.availability ? <p className="text-sm text-ink-500">—</p> : null}
              </div>
              {l.availability === "SUBSTITUTE" && l.substituteApproved === null && d.can.approve ? (
                <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={`Substitute for ${l.name}`}>
                  <button type="button" className={clsx(subs[l.id] === true ? BTN_PRIMARY : BTN_SECONDARY)} aria-pressed={subs[l.id] === true} onClick={() => setSubs((s) => ({ ...s, [l.id]: true }))} data-testid="rx-sub-accept">
                    Accept substitute
                  </button>
                  <button type="button" className={clsx(subs[l.id] === false ? BTN_DANGER : BTN_SECONDARY)} aria-pressed={subs[l.id] === false} onClick={() => setSubs((s) => ({ ...s, [l.id]: false }))} data-testid="rx-sub-reject">
                    Reject (drop this line)
                  </button>
                </div>
              ) : null}
              {l.substituteApproved === false ? <p className="mt-1 text-xs font-bold text-stone-600">Substitute rejected — not bought.</p> : null}
            </li>
          ))}
        </ul>
        {o.status !== "SENT" && o.totalPaise > 0 ? (
          <dl className="mt-3 grid grid-cols-2 gap-1 text-sm">
            <dt className="text-ink-600">Delivery</dt>
            <dd className="text-right">{amount(o.deliveryPaise)}</dd>
            {o.discountPaise ? (
              <>
                <dt className="text-ink-600">Discount</dt>
                <dd className="text-right">− {amount(o.discountPaise)}</dd>
              </>
            ) : null}
            <dt className="font-bold text-ink-900">Total</dt>
            <dd className="text-right font-extrabold" data-testid="rx-total">
              {amount(d.can.approve && !d.can.pay ? preview : o.totalPaise)}
            </dd>
            {o.paidOnlinePaise ? (
              <>
                <dt className="text-ink-600">Paid online</dt>
                <dd className="text-right">{amount(o.paidOnlinePaise)}</dd>
              </>
            ) : null}
            {o.paidOfflinePaise ? (
              <>
                <dt className="text-ink-600">Paid at handover</dt>
                <dd className="text-right">{amount(o.paidOfflinePaise)}</dd>
              </>
            ) : null}
            {o.refundPaise ? (
              <>
                <dt className="text-ink-600">Refund</dt>
                <dd className="text-right font-bold text-teal-800" data-testid="rx-refund">
                  {amount(o.refundPaise)} · {d.refund.status === "DONE" ? "refunded" : d.refund.status === "FAILED" ? "delayed — support is on it" : "on the way (5–7 working days)"}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {d.can.approve && !d.can.pay ? (
          <div className="mt-3 rounded-xl border-2 border-amber-300 bg-amber-50 p-3">
            <p className="mb-2 text-sm font-bold text-amber-900">{subLines.length ? "Accept or reject each substitute, then choose how to pay." : "Choose how to pay."}</p>
            <div className="flex flex-wrap gap-2">
              <label className={clsx("flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 px-3", mode === "ONLINE" ? "border-kesari-700 bg-white" : "border-[var(--gk-line)] bg-white")}>
                <input type="radio" name="pay" className="h-5 w-5 accent-kesari-700" checked={mode === "ONLINE"} onChange={() => setMode("ONLINE")} />
                Pay online now (UPI, card, net banking)
              </label>
              {d.store.cashOnHandover ? (
                <label className={clsx("flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 px-3", mode === "CASH_ON_HANDOVER" ? "border-kesari-700 bg-white" : "border-[var(--gk-line)] bg-white")}>
                  <input type="radio" name="pay" className="h-5 w-5 accent-kesari-700" checked={mode === "CASH_ON_HANDOVER"} onChange={() => setMode("CASH_ON_HANDOVER")} />
                  Pay at {o.fulfilment === "PICKUP" ? "pickup" : "delivery"}
                </label>
              ) : null}
            </div>
            <button type="button" className={clsx(BTN_PRIMARY, "mt-3 w-full sm:w-auto")} disabled={busy || !allDecided} onClick={() => act("approve", { substitutes: subs, paymentMode: mode }, "Approved. The store will pack your medicines.")} data-testid="rx-approve">
              {mode === "ONLINE" ? `Approve and pay ${amount(preview)}` : `Approve ${amount(preview)}`}
            </button>
          </div>
        ) : null}
        {d.can.pay ? (
          <div className="mt-3">
            {o.paymentStatus === "FAILED" ? <p className="mb-2 text-sm font-bold text-red-800">The payment did not go through. You can try again.</p> : <p className="mb-2 text-sm text-ink-700">Payment pending.</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BTN_PRIMARY} onClick={() => act("pay")} disabled={busy} data-testid="rx-pay">
                Pay {amount(o.totalPaise)}
              </button>
              {d.store.cashOnHandover ? (
                <button type="button" className={BTN_SECONDARY} onClick={() => act("approve", { substitutes: {}, paymentMode: "CASH_ON_HANDOVER" }, "You will pay at handover. The store will pack your medicines.")} disabled={busy} data-testid="rx-pay-cash-instead">
                  Pay at {o.fulfilment === "PICKUP" ? "pickup" : "delivery"} instead
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Box>

      <div className="grid gap-3 md:grid-cols-2">
        <Box title={o.fulfilment === "PICKUP" ? "Pickup" : "Delivery"}>
          {o.fulfilment === "PICKUP" ? (
            <>
              <p className="text-sm text-ink-800">{d.store.address}</p>
              {o.pickupAt ? <p className="text-sm text-ink-700">Preferred time: {ist(o.pickupAt)}</p> : null}
              {d.store.latitude != null && d.store.longitude != null ? (
                <a href={`https://www.google.com/maps/dir/?api=1&destination=${d.store.latitude},${d.store.longitude}`} target="_blank" rel="noreferrer" className={clsx(BTN_SECONDARY, "mt-2")}>
                  Directions
                </a>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-sm text-ink-800">{addressLine(o.address)}</p>
              <p className="mt-1 text-xs text-ink-600">Delivered by the store&apos;s own staff. GoKesari rider delivery for medicines comes in phase 2.</p>
            </>
          )}
          {d.store.phone ? (
            <a href={`tel:${d.store.phone}`} className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-kesari-800 underline">
              Call the store
            </a>
          ) : null}
        </Box>
        <Box title="Prescription">
          {d.prescription ? (
            <>
              <p className="text-sm text-ink-800">
                {d.prescription.rxNumber} · {d.prescription.doctor}
              </p>
              <Link href={`/health/prescriptions/${d.prescription.id}`} className="mt-1 inline-flex min-h-11 items-center text-sm font-bold text-kesari-800 underline">
                Open prescription
              </Link>
            </>
          ) : null}
          {d.billDocumentId ? (
            <a href={`/api/health/rx-orders/${o.id}/bill`} target="_blank" rel="noreferrer" className={clsx(BTN_SECONDARY, "mt-2")} data-testid="rx-bill">
              Bill {o.billNumber}
            </a>
          ) : null}
        </Box>
      </div>

      <div className="flex flex-wrap gap-2">
        {d.can.cancel ? (
          <button type="button" className={BTN_DANGER} onClick={() => setOpen(open === "cancel" ? null : "cancel")} data-testid="rx-cancel">
            Cancel order
          </button>
        ) : null}
        {d.can.report ? (
          <button type="button" className={BTN_SECONDARY} onClick={() => setOpen(open === "problem" ? null : "problem")} data-testid="rx-report">
            Report a problem
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3">
          <label className="block">
            <span className="mb-1 block text-sm font-bold text-ink-800">{open === "cancel" ? "Why are you cancelling? (optional)" : "What went wrong?"}</span>
            <textarea className={inputCls} rows={3} value={text} onChange={(e) => setText(e.target.value)} data-testid="rx-reason" />
          </label>
          {open === "cancel" && o.paidOnlinePaise > o.refundPaise ? <p className="mt-1 text-sm text-ink-700">{amount(o.paidOnlinePaise - o.refundPaise)} goes back to the way you paid.</p> : null}
          <button type="button" className={clsx(open === "cancel" ? BTN_DANGER : BTN_PRIMARY, "mt-2")} disabled={busy} onClick={() => (open === "cancel" ? act("cancel", { reason: text }, "Order cancelled.") : act("problem", { reason: text }))} data-testid="rx-confirm">
            {open === "cancel" ? "Cancel the order" : "Send to GoKesari support"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
