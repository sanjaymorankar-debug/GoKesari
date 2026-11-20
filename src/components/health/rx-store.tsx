"use client";

/**
 * GoKesari Health "Get medicines", medical store side (src/server/health/rx-orders.ts):
 *  - StoreRxOrderView: the request (prescription summary, doctor and registration, checks), quote per line
 *    or decline, pack → ready for pickup / out for delivery, complete with the customer's code and the bill
 *  - PharmacyProfileForm: drug licence, registered pharmacist, delivery options
 */
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { amount, api, ist } from "./api";
import { chime, useHealthLive } from "./live";
import { BTN_PRIMARY, BTN_SECONDARY } from "./styles";
import { addressLine, Countdown, RxStatusPill, type RxDetail } from "./rx-patient";

const inputCls = "min-h-11 w-full rounded-xl border-2 border-[var(--gk-line)] bg-white px-3 py-2 text-base text-ink-900 focus:border-kesari-500 focus:outline-none";
const BTN_DANGER = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border-2 border-red-300 bg-white px-4 py-2 text-sm font-extrabold text-red-800 hover:bg-red-50 disabled:opacity-60";
const AVAILABILITY = [
  ["AVAILABLE", "Available"],
  ["PARTIAL", "Partly available"],
  ["UNAVAILABLE", "Not available"],
  ["SUBSTITUTE", "Substitute (same medicine and strength)"],
] as const;

const toPaise = (rupees: string) => {
  const n = Number(rupees.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

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

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={clsx("flex items-center gap-2 text-sm font-semibold", ok ? "text-leaf-800" : "text-red-800")}>
      <span aria-hidden className={clsx("inline-flex h-6 w-6 items-center justify-center rounded-full text-white", ok ? "bg-leaf-600" : "bg-red-600")}>
        {ok ? "✓" : "!"}
      </span>
      {label}
    </li>
  );
}

interface QuoteRow {
  availability: string;
  qty: string;
  price: string;
  discount: string;
  subName: string;
  subGeneric: string;
  subStrength: string;
}

interface BillRow {
  qty: string;
  batch: string;
  expiry: string;
}

export function StoreRxOrderView({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [d, setD] = useState<RxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<Record<string, QuoteRow>>({});
  const [delivery, setDelivery] = useState("0");
  const [bill, setBill] = useState<Record<string, BillRow>>({});
  const [billNumber, setBillNumber] = useState("");
  const [code, setCode] = useState("");
  const [person, setPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [open, setOpen] = useState<null | "decline" | "cancel" | "problem" | "dispatch">(null);
  const [text, setText] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api<RxDetail>(`/api/health/rx-orders/${orderId}`);
      setD(r);
      setQuote((q) => {
        const next = { ...q };
        for (const l of r.lines) next[l.id] ??= { availability: "AVAILABLE", qty: String(l.requestedQty), price: "", discount: "", subName: "", subGeneric: l.genericName, subStrength: l.strength ?? "" };
        return next;
      });
      setBill((b) => {
        const next = { ...b };
        for (const l of r.lines) next[l.id] ??= { qty: String(l.quotedQty), batch: "", expiry: "" };
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the request.");
    }
  }, [orderId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system)
    void load();
  }, [load]);
  const live = useHealthLive(
    (e) => e.subjectId === orderId,
    (e) => {
      if (e.name === "rx.approved" || e.name === "rx.cancelled") chime();
      void load();
    },
  );

  const act = async (action: string, extra: Record<string, unknown> = {}, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ ticketNumber?: string }>(`/api/health/rx-orders/${orderId}`, { json: { action, ...extra } });
      setOpen(null);
      setText("");
      setNotice(r.ticketNumber ? `Ticket ${r.ticketNumber} opened with GoKesari support.` : (done ?? null));
      await load();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const quoteTotal = useMemo(() => {
    if (!d) return 0;
    let t = 0;
    for (const l of d.lines) {
      const q = quote[l.id];
      if (!q || q.availability === "UNAVAILABLE") continue;
      const qty = q.availability === "AVAILABLE" ? l.requestedQty : Number(q.qty) || 0;
      t += toPaise(q.price) * qty - toPaise(q.discount);
    }
    return Math.max(0, t) + (d.order.fulfilment === "DELIVERY" ? toPaise(delivery) : 0);
  }, [d, quote, delivery]);

  if (error && !d) return <p role="alert" className="rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">{error}</p>;
  if (!d) return <p className="text-sm text-ink-600">Loading…</p>;
  const o = d.order;

  const sendQuote = () =>
    act(
      "quote",
      {
        items: d.lines.map((l) => {
          const q = quote[l.id];
          return {
            id: l.id,
            availability: q.availability,
            quotedQty: q.availability === "PARTIAL" || q.availability === "SUBSTITUTE" ? Number(q.qty) || 0 : null,
            unitPricePaise: q.availability === "UNAVAILABLE" ? 0 : toPaise(q.price),
            discountPaise: q.availability === "UNAVAILABLE" ? 0 : toPaise(q.discount),
            substituteName: q.availability === "SUBSTITUTE" ? q.subName : null,
            substituteGeneric: q.availability === "SUBSTITUTE" ? q.subGeneric : null,
            substituteStrength: q.availability === "SUBSTITUTE" ? q.subStrength : null,
          };
        }),
        deliveryPaise: o.fulfilment === "DELIVERY" ? toPaise(delivery) : 0,
      },
      "Quote sent. The customer has been told.",
    );

  const complete = () =>
    act(
      "complete",
      {
        code,
        billNumber,
        items: d.lines.map((l) => ({ id: l.id, dispensedQty: l.quotedQty > 0 ? Number(bill[l.id]?.qty) || 0 : 0, batchNumber: bill[l.id]?.batch || null, expiryDate: bill[l.id]?.expiry || null })),
      },
      "Completed. The bill is saved in the customer's health record.",
    );

  return (
    <div className="flex flex-col gap-3" data-testid="rx-store-view">
      <div className="flex flex-wrap items-start justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
        <div>
          <p className="text-xs font-bold text-ink-600">
            {o.orderNumber} · received {ist(o.createdAt)}
          </p>
          <h2 className="text-lg font-extrabold text-ink-900">{d.patient.name}</h2>
          <p className="text-sm text-ink-700">
            {[d.patient.age, d.patient.gender].filter(Boolean).join(" / ")}
            {o.fulfilment === "PICKUP" ? ` · Pickup${o.pickupAt ? ` around ${ist(o.pickupAt)}` : ""}` : ` · Delivery${o.distanceKm != null ? ` · ${o.distanceKm} km` : ""}`}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <RxStatusPill status={o.status} />
          <span className="text-xs text-ink-500" data-testid="health-live" data-status={live}>
            {live === "live" ? "Live" : live === "connecting" ? "Connecting…" : "Offline"}
          </span>
        </div>
      </div>
      {notice ? <p className="rounded-xl border-2 border-leaf-300 bg-leaf-50 px-3 py-2 text-sm font-semibold text-leaf-800">{notice}</p> : null}
      {error ? (
        <p role="alert" className="rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}
      {o.status === "SENT" ? (
        <p className="rounded-xl border-2 border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
          Reply within <Countdown seconds={o.secondsLeft} onZero={() => void load()} />. After that the customer is offered other stores.
        </p>
      ) : null}
      {o.status === "EXPIRED" ? <p className="rounded-xl border-2 border-stone-300 bg-stone-50 px-3 py-2 text-sm font-bold text-stone-800">This request expired before you replied. Its prescription is no longer shown to you.</p> : null}

      {d.prescription ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Box title="Prescription">
            <dl className="grid grid-cols-[7.5rem_1fr] gap-x-2 gap-y-1 text-sm">
              <dt className="text-ink-600">Number</dt>
              <dd className="font-bold">
                {d.prescription.rxNumber}
                {d.prescription.version > 1 ? ` (v${d.prescription.version})` : ""}
              </dd>
              <dt className="text-ink-600">Doctor</dt>
              <dd>{d.prescription.doctor}</dd>
              <dt className="text-ink-600">Registration</dt>
              <dd data-testid="rx-doctor-reg">
                {d.prescription.registration} · {d.prescription.council}
              </dd>
              <dt className="text-ink-600">Clinic</dt>
              <dd>{d.prescription.clinic}</dd>
              <dt className="text-ink-600">Issued</dt>
              <dd>{ist(d.prescription.issuedAt)}</dd>
              <dt className="text-ink-600">Valid until</dt>
              <dd>{d.prescription.validUntil ?? "—"}</dd>
            </dl>
            <a href={`/api/health/rx-orders/${o.id}/prescription`} target="_blank" rel="noreferrer" className={clsx(BTN_SECONDARY, "mt-2")} data-testid="rx-open-prescription">
              Open prescription PDF
            </a>
          </Box>
          {d.checks ? (
            <Box title="Checks">
              <ul className="flex flex-col gap-1.5" data-testid="rx-checks">
                <Check ok={d.checks.doctorVerified} label={d.checks.doctorVerified ? "Doctor verified by GoKesari" : "Doctor not verified yet"} />
                <Check ok={d.checks.qrValid} label={d.checks.qrValid ? "QR authentic, latest version" : `QR: ${d.checks.qrStatus.toLowerCase().replace(/_/g, " ")}`} />
                <Check ok={d.checks.withinValidity} label={d.checks.withinValidity ? "Within the validity date" : "Validity date passed"} />
                <Check ok={d.checks.itemsAllowedOnline} label={d.checks.itemsAllowedOnline ? "All medicines may be sold online" : "A medicine may not be sold online"} />
              </ul>
              {d.checks.notes.length ? (
                <ul className="mt-2 list-disc pl-5 text-sm text-red-800">
                  {d.checks.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </Box>
          ) : null}
        </div>
      ) : null}

      {o.fulfilment === "DELIVERY" && o.address ? (
        <Box title="Deliver to">
          <p className="text-sm text-ink-800">{addressLine(o.address)}</p>
          <p className="text-sm text-ink-700">
            {o.address.recipientName ?? d.patient.name}
            {o.address.recipientPhone ? (
              <>
                {" "}
                ·{" "}
                <a className="font-bold text-kesari-800 underline" href={`tel:${o.address.recipientPhone}`}>
                  {o.address.recipientPhone}
                </a>
              </>
            ) : null}
            {o.distanceKm != null ? ` · ${o.distanceKm} km from you` : ""}
          </p>
          {o.address.deliveryInstructions ? <p className="text-sm text-ink-700">Note: {o.address.deliveryInstructions}</p> : null}
          {o.address.latitude && o.address.longitude ? (
            <a href={`https://www.google.com/maps/dir/?api=1&destination=${o.address.latitude},${o.address.longitude}`} target="_blank" rel="noreferrer" className={clsx(BTN_SECONDARY, "mt-2")}>
              Directions
            </a>
          ) : null}
        </Box>
      ) : null}

      {d.lines.length ? (
        <Box title={d.can.quote ? "Your quote" : "Medicines"}>
          <ul className="flex flex-col gap-2">
            {d.lines.map((l) => {
              const q = quote[l.id];
              return (
                <li key={l.id} className="rounded-xl border-2 border-[var(--gk-line)] p-3" data-testid="rx-store-line">
                  <p className="font-extrabold text-ink-900">
                    {l.name} · asked {l.requestedQty}
                  </p>
                  <p className="text-xs text-ink-600">
                    {l.dose} · {l.frequency} · {l.durationDays} days · prescribed {l.prescribedQty}
                    {l.alreadyDispensed ? `, ${l.alreadyDispensed} already supplied` : ""}
                  </p>
                  {d.can.quote && q ? (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <label className="block sm:col-span-2">
                        <span className="mb-1 block text-xs font-bold text-ink-700">Availability</span>
                        <select className={inputCls} value={q.availability} onChange={(e) => setQuote((s) => ({ ...s, [l.id]: { ...q, availability: e.target.value } }))} data-testid="rx-quote-availability">
                          {AVAILABILITY.map(([v, label]) => (
                            <option key={v} value={v}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {q.availability === "SUBSTITUTE" ? (
                        <>
                          <label className="block sm:col-span-2">
                            <span className="mb-1 block text-xs font-bold text-ink-700">Substitute brand</span>
                            <input className={inputCls} value={q.subName} onChange={(e) => setQuote((s) => ({ ...s, [l.id]: { ...q, subName: e.target.value } }))} data-testid="rx-quote-sub-name" />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold text-ink-700">Its generic (must be {l.genericName})</span>
                            <input className={inputCls} value={q.subGeneric} onChange={(e) => setQuote((s) => ({ ...s, [l.id]: { ...q, subGeneric: e.target.value } }))} />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold text-ink-700">Its strength (must be {l.strength ?? "as prescribed"})</span>
                            <input className={inputCls} value={q.subStrength} onChange={(e) => setQuote((s) => ({ ...s, [l.id]: { ...q, subStrength: e.target.value } }))} />
                          </label>
                        </>
                      ) : null}
                      {q.availability === "PARTIAL" || q.availability === "SUBSTITUTE" ? (
                        <label className="block">
                          <span className="mb-1 block text-xs font-bold text-ink-700">Quantity you can give</span>
                          <input className={inputCls} inputMode="numeric" value={q.qty} onChange={(e) => setQuote((s) => ({ ...s, [l.id]: { ...q, qty: e.target.value.replace(/\D/g, "") } }))} data-testid="rx-quote-qty" />
                        </label>
                      ) : null}
                      {q.availability !== "UNAVAILABLE" ? (
                        <>
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold text-ink-700">Price per unit (₹)</span>
                            <input className={inputCls} inputMode="decimal" value={q.price} onChange={(e) => setQuote((s) => ({ ...s, [l.id]: { ...q, price: e.target.value } }))} data-testid="rx-quote-price" />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold text-ink-700">Discount on this line (₹)</span>
                            <input className={inputCls} inputMode="decimal" value={q.discount} onChange={(e) => setQuote((s) => ({ ...s, [l.id]: { ...q, discount: e.target.value } }))} />
                          </label>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-1 text-sm text-ink-800">
                      {l.availability === "SUBSTITUTE" ? `Substitute ${l.substituteName} (${l.substituteApproved === null ? "customer to decide" : l.substituteApproved ? "accepted" : "rejected"}) · ` : ""}
                      {l.availability ? `Quoted ${l.quotedQty} × ${amount(l.unitPricePaise)}${l.discountPaise ? ` − ${amount(l.discountPaise)}` : ""} = ${amount(l.lineTotalPaise)}` : "Not quoted yet"}
                      {l.dispensedQty ? ` · supplied ${l.dispensedQty} (batch ${l.batchNumber}, exp ${l.expiryDate})` : ""}
                    </p>
                  )}
                  {d.can.complete && l.quotedQty > 0 ? (
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <label className="block">
                        <span className="mb-1 block text-xs font-bold text-ink-700">Supplied (max {l.quotedQty})</span>
                        <input className={inputCls} inputMode="numeric" value={bill[l.id]?.qty ?? ""} onChange={(e) => setBill((b) => ({ ...b, [l.id]: { ...b[l.id], qty: e.target.value.replace(/\D/g, "") } }))} data-testid="rx-bill-qty" />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-bold text-ink-700">Batch number</span>
                        <input className={inputCls} value={bill[l.id]?.batch ?? ""} onChange={(e) => setBill((b) => ({ ...b, [l.id]: { ...b[l.id], batch: e.target.value } }))} data-testid="rx-bill-batch" />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-bold text-ink-700">Expiry date</span>
                        <input type="date" className={inputCls} value={bill[l.id]?.expiry ?? ""} onChange={(e) => setBill((b) => ({ ...b, [l.id]: { ...b[l.id], expiry: e.target.value } }))} data-testid="rx-bill-expiry" />
                      </label>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {d.can.quote ? (
            <>
              {o.fulfilment === "DELIVERY" ? (
                <label className="mt-3 block">
                  <span className="mb-1 block text-sm font-bold text-ink-800">Delivery charge (₹)</span>
                  <input className={inputCls} inputMode="decimal" value={delivery} onChange={(e) => setDelivery(e.target.value)} data-testid="rx-quote-delivery" />
                </label>
              ) : null}
              <p className="mt-3 text-right text-lg font-extrabold">Total {amount(quoteTotal)}</p>
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                <button type="button" className={BTN_DANGER} onClick={() => setOpen(open === "decline" ? null : "decline")} disabled={busy} data-testid="rx-decline">
                  Decline
                </button>
                <button type="button" className={BTN_PRIMARY} onClick={sendQuote} disabled={busy} data-testid="rx-send-quote">
                  Send quote
                </button>
              </div>
            </>
          ) : o.status !== "SENT" && o.totalPaise ? (
            <dl className="mt-3 grid grid-cols-2 gap-1 text-sm">
              <dt className="text-ink-600">Delivery</dt>
              <dd className="text-right">{amount(o.deliveryPaise)}</dd>
              <dt className="font-bold">Total</dt>
              <dd className="text-right font-extrabold">{amount(o.totalPaise)}</dd>
              <dt className="text-ink-600">Payment</dt>
              <dd className="text-right">
                {o.paymentMode === "CASH_ON_HANDOVER" ? (o.status === "COMPLETED" ? "Cash collected" : "Collect at handover") : o.paymentStatus === "PAID" ? "Paid online" : o.paymentStatus === "REFUNDED" ? "Refunded" : "Waiting for online payment"}
              </dd>
              {o.refundPaise ? (
                <>
                  <dt className="text-ink-600">Refunded to customer</dt>
                  <dd className="text-right">{amount(o.refundPaise)}</dd>
                </>
              ) : null}
              {o.commissionPaise ? (
                <>
                  <dt className="text-ink-600">GoKesari commission</dt>
                  <dd className="text-right">{amount(o.commissionPaise)}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </Box>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {d.can.pack ? (
          <button type="button" className={BTN_PRIMARY} onClick={() => act("pack", {}, "Marked packed.")} disabled={busy} data-testid="rx-pack">
            Mark packed
          </button>
        ) : null}
        {d.can.ready ? (
          <button type="button" className={BTN_PRIMARY} onClick={() => act("ready", {}, "Ready for pickup — the customer has been told and has a pickup code.")} disabled={busy} data-testid="rx-ready">
            Ready for pickup
          </button>
        ) : null}
        {d.can.dispatch ? (
          <button type="button" className={BTN_PRIMARY} onClick={() => setOpen(open === "dispatch" ? null : "dispatch")} disabled={busy} data-testid="rx-dispatch">
            Send out for delivery
          </button>
        ) : null}
        {d.can.storeCancel ? (
          <button type="button" className={BTN_DANGER} onClick={() => setOpen(open === "cancel" ? null : "cancel")} disabled={busy} data-testid="rx-store-cancel">
            Cancel order
          </button>
        ) : null}
        {d.can.report ? (
          <button type="button" className={BTN_SECONDARY} onClick={() => setOpen(open === "problem" ? null : "problem")} disabled={busy}>
            Report a problem
          </button>
        ) : null}
        {d.billDocumentId ? (
          <a href={`/api/health/rx-orders/${o.id}/bill`} target="_blank" rel="noreferrer" className={BTN_SECONDARY} data-testid="rx-bill">
            Bill {o.billNumber}
          </a>
        ) : null}
      </div>

      {open === "dispatch" ? (
        <Box title="Out for delivery">
          <p className="mb-2 text-xs text-ink-600">Your own delivery person. GoKesari rider delivery for medicines comes in phase 2.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-bold text-ink-800">Name</span>
              <input className={inputCls} value={person} onChange={(e) => setPerson(e.target.value)} data-testid="rx-delivery-person" />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-bold text-ink-800">Mobile</span>
              <input className={inputCls} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="rx-delivery-phone" />
            </label>
          </div>
          <button type="button" className={clsx(BTN_PRIMARY, "mt-2")} onClick={() => act("dispatch", { deliveryPerson: person, deliveryPhone: phone }, "Out for delivery — the customer has a delivery code.")} disabled={busy} data-testid="rx-dispatch-confirm">
            Send out
          </button>
        </Box>
      ) : null}

      {open === "decline" || open === "cancel" || open === "problem" ? (
        <Box title={open === "decline" ? "Decline the request" : open === "cancel" ? "Cancel the order" : "Report a problem"}>
          <label className="block">
            <span className="mb-1 block text-sm font-bold text-ink-800">{open === "problem" ? "What went wrong?" : "Reason (the customer sees it)"}</span>
            <textarea className={inputCls} rows={3} value={text} onChange={(e) => setText(e.target.value)} data-testid="rx-store-reason" />
          </label>
          {open === "cancel" && o.paidOnlinePaise > o.refundPaise ? <p className="mt-1 text-sm text-ink-700">The customer gets {amount(o.paidOnlinePaise - o.refundPaise)} back in full.</p> : null}
          <button
            type="button"
            className={clsx(open === "problem" ? BTN_PRIMARY : BTN_DANGER, "mt-2")}
            disabled={busy}
            onClick={() => (open === "decline" ? act("decline", { reason: text }, "Declined. The customer was told.") : open === "cancel" ? act("cancel", { reason: text }, "Cancelled. The customer was told.") : act("problem", { reason: text }))}
            data-testid="rx-store-confirm"
          >
            {open === "decline" ? "Decline" : open === "cancel" ? "Cancel the order" : "Send to GoKesari support"}
          </button>
        </Box>
      ) : null}

      {d.can.complete ? (
        <Box title={o.fulfilment === "PICKUP" ? "Hand over at the counter" : "Hand over at the door"}>
          <p className="mb-2 text-sm text-ink-700">
            Enter the supplied quantity, batch and expiry above, your bill number, and the customer&apos;s 4-digit code ({d.otpTriesLeft} {d.otpTriesLeft === 1 ? "try" : "tries"} left).
            {o.paymentMode === "CASH_ON_HANDOVER" ? ` Collect the amount on your bill (up to ${amount(o.totalPaise)}).` : " Already paid online."}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-bold text-ink-800">Bill number</span>
              <input className={inputCls} value={billNumber} onChange={(e) => setBillNumber(e.target.value)} data-testid="rx-bill-number" />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-bold text-ink-800">Customer&apos;s code</span>
              <input className={clsx(inputCls, "tracking-[0.3em]")} inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} data-testid="rx-code" />
            </label>
          </div>
          <button type="button" className={clsx(BTN_PRIMARY, "mt-3 w-full sm:w-auto")} onClick={complete} disabled={busy || code.length !== 4 || !billNumber} data-testid="rx-complete">
            Complete and save the bill
          </button>
        </Box>
      ) : null}
    </div>
  );
}

/** The inbox's live link: refreshes on every request / order change for this store, with a sound for new requests, approvals and cancellations. */
export function StoreInboxLive({ shopId }: { shopId: string }) {
  const router = useRouter();
  const status = useHealthLive(
    (e) => (e.name.startsWith("rx.") || e.name.startsWith("order.")) && e.shopId === shopId,
    (e) => {
      if (e.name === "rx.forwarded" || e.name === "rx.approved" || e.name === "rx.cancelled") chime();
      router.refresh();
    },
  );
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-ink-600" data-testid="health-live" data-status={status} aria-live="polite">
      <span className={status === "live" ? "h-2 w-2 rounded-full bg-leaf-600" : status === "connecting" ? "h-2 w-2 rounded-full bg-amber-500" : "h-2 w-2 rounded-full bg-stone-400"} />
      {status === "live" ? "Live — new requests ring" : status === "connecting" ? "Connecting…" : "Offline — pull to refresh"}
    </span>
  );
}

/* ------------------------------------------------------------ pharmacy profile */

export interface PharmacyProfileValues {
  drugLicenceNumber: string;
  pharmacistName: string;
  pharmacistRegistrationNumber: string;
  pharmacyCouncil: string | null;
  acceptsPrescriptions: boolean;
  ownDelivery: boolean;
  cashOnHandover: boolean;
  deliveryRadiusKm: number;
  verification: string;
  verificationNote: string | null;
}

export function PharmacyProfileForm({ shopId, initial }: { shopId: string; initial: PharmacyProfileValues | null }) {
  const router = useRouter();
  const [v, setV] = useState({
    drugLicenceNumber: initial?.drugLicenceNumber ?? "",
    pharmacistName: initial?.pharmacistName ?? "",
    pharmacistRegistrationNumber: initial?.pharmacistRegistrationNumber ?? "",
    pharmacyCouncil: initial?.pharmacyCouncil ?? "",
    acceptsPrescriptions: initial?.acceptsPrescriptions ?? true,
    ownDelivery: initial?.ownDelivery ?? true,
    cashOnHandover: initial?.cashOnHandover ?? true,
    deliveryRadiusKm: String(initial?.deliveryRadiusKm ?? 5),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const r = await api<{ profile: { verification: string } }>("/api/health/pharmacy", {
        json: { shopId, ...v, pharmacyCouncil: v.pharmacyCouncil || null, deliveryRadiusKm: Number(v.deliveryRadiusKm) || 5 },
      });
      setSaved(r.profile.verification === "VERIFIED" ? "Saved." : "Saved. GoKesari will verify the drug licence and pharmacist; you start getting prescriptions once verified.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const text = (key: "drugLicenceNumber" | "pharmacistName" | "pharmacistRegistrationNumber" | "pharmacyCouncil", label: string, hint?: string) => (
    <label className="block">
      <span className="mb-1 block text-sm font-bold text-ink-800">{label}</span>
      <input className={inputCls} value={v[key]} onChange={(e) => setV((s) => ({ ...s, [key]: e.target.value }))} data-testid={`pharmacy-${key}`} />
      {hint ? <span className="mt-1 block text-xs text-ink-600">{hint}</span> : null}
    </label>
  );
  const toggle = (key: "acceptsPrescriptions" | "ownDelivery" | "cashOnHandover", label: string) => (
    <label className="flex min-h-11 items-center gap-3 rounded-xl border-2 border-[var(--gk-line)] px-3">
      <input type="checkbox" className="h-6 w-6 accent-kesari-700" checked={v[key]} onChange={(e) => setV((s) => ({ ...s, [key]: e.target.checked }))} data-testid={`pharmacy-${key}`} />
      <span className="text-sm font-bold text-ink-900">{label}</span>
    </label>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="pharmacy-form">
      {initial ? (
        <p
          className={clsx(
            "rounded-xl border-2 px-3 py-2 text-sm font-bold",
            initial.verification === "VERIFIED" ? "border-leaf-300 bg-leaf-50 text-leaf-800" : initial.verification === "REJECTED" ? "border-red-300 bg-red-50 text-red-800" : "border-amber-300 bg-amber-50 text-amber-900",
          )}
          data-testid="pharmacy-verification"
        >
          {initial.verification === "VERIFIED" ? "Verified by GoKesari — patients can send you prescriptions." : initial.verification === "REJECTED" ? `Not verified: ${initial.verificationNote ?? "please correct the details."}` : "Waiting for GoKesari to verify the drug licence and pharmacist."}
        </p>
      ) : null}
      <section className="grid gap-3 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4 sm:grid-cols-2">
        {text("drugLicenceNumber", "Drug licence number", "Retail drug licence (Form 20 / 21). A change is verified again.")}
        {text("pharmacistName", "Registered pharmacist")}
        {text("pharmacistRegistrationNumber", "Pharmacist registration number")}
        {text("pharmacyCouncil", "State pharmacy council")}
      </section>
      <section className="grid gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
        {toggle("acceptsPrescriptions", "Take prescription requests from GoKesari patients")}
        {toggle("ownDelivery", "We deliver with our own staff")}
        {v.ownDelivery ? (
          <label className="block">
            <span className="mb-1 block text-sm font-bold text-ink-800">Delivery radius (km, 1–50)</span>
            <input className={inputCls} inputMode="numeric" value={v.deliveryRadiusKm} onChange={(e) => setV((s) => ({ ...s, deliveryRadiusKm: e.target.value.replace(/\D/g, "") }))} data-testid="pharmacy-radius" />
          </label>
        ) : null}
        {toggle("cashOnHandover", "Customers may pay cash at pickup / delivery")}
        <p className="text-xs text-ink-600">GoKesari rider delivery for medicines comes in phase 2. GoKesari keeps a commission on each completed order, taken from your weekly payout.</p>
      </section>
      {error ? (
        <p role="alert" className="rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}
      {saved ? <p className="rounded-xl border-2 border-leaf-300 bg-leaf-50 px-3 py-2 text-sm font-semibold text-leaf-800">{saved}</p> : null}
      <div>
        <button type="button" className={BTN_PRIMARY} onClick={save} disabled={busy} data-testid="pharmacy-save">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
