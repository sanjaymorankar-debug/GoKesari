"use client";

/**
 * gokesari.com delivery partner (Pico Xpress) on the shop's order card, the customer's order card and the
 * operations pages (docs/pico-xpress-2026-11). Reads /api/orders/[id]/pico; the server decides what each
 * viewer may see (pickup code: shop; delivery code: customer). Times are shown in IST.
 */
import { useCallback, useEffect, useState } from "react";

import { TrackDeliveryButton } from "@/components/live-tracking-map";
import { Alert, Badge, Button } from "@/components/ui";
import { formatPaise } from "@/lib/money";

export interface PicoTimelineEntry {
  status: string;
  label: string;
  at: string;
  atIst: string;
  reason: string | null;
}

export interface PicoShipment {
  shipmentId: string;
  awbNumber: string;
  picoOrderId: string;
  status: string;
  statusLabel: string;
  live: boolean;
  paymentType: "COD" | "PREPAID";
  collectiblePaise: number;
  numBoxes: number;
  rider: { name: string | null; phone: string | null } | null;
  trackingUrl: string | null;
  pickupEtaMin: number | null;
  deliveryEtaMin: number | null;
  etaIst: string | null;
  deliveredAtIst: string | null;
  lastReason: string | null;
  cancellable: boolean;
  unconfirmed: boolean;
  bookingFailed: boolean;
  timeline: PicoTimelineEntry[];
  pickupCode?: string;
  deliveryCode?: string;
}

export interface PicoOption {
  enabled: boolean;
  available: boolean;
  reason: string | null;
  serviceable: boolean | null;
  paymentType: "COD" | "PREPAID";
  collectiblePaise: number;
  goodsTotalPaise: number;
  needsEwayBill: boolean;
  maxBoxes: number;
  booked: boolean;
}

interface PicoGet {
  role: "customer" | "shop" | "operations";
  shipment: PicoShipment | null;
  option?: PicoOption | null;
  cancelReasons?: string[] | null;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error?.message ?? "Something went wrong. Please try again.");
  return payload as T;
}

/** The planner asks this before offering the choice. */
export async function fetchPicoOption(orderId: string): Promise<PicoOption | null> {
  try {
    const data = await call<PicoGet>(`/api/orders/${orderId}/pico?check=1`);
    return data.option ?? null;
  } catch {
    return null;
  }
}

function usePico(orderId: string, pollWhileLive = true) {
  const [data, setData] = useState<PicoGet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let cancelled = false;
    call<PicoGet>(`/api/orders/${orderId}/pico`).then(
      (d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the delivery status.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orderId, version]);
  const live = data?.shipment?.live ?? false;
  useEffect(() => {
    if (!pollWhileLive || !live) return;
    const t = setInterval(reload, 20_000);
    return () => clearInterval(t);
  }, [live, reload, pollWhileLive]);
  return { data, error, reload };
}

function Timeline({ entries }: { entries: PicoTimelineEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <ol className="mt-2 space-y-1 border-l-2 border-cream-200 pl-3 text-xs text-ink-700" data-testid="pico-timeline">
      {entries.map((e) => (
        <li key={`${e.status}-${e.at}`}>
          <span className="font-medium text-ink-900">{e.label}</span> · {e.atIst}
          {e.reason ? <span className="text-ink-500"> — {e.reason}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function RiderLine({ s }: { s: PicoShipment }) {
  if (!s.rider?.name && !s.rider?.phone) return null;
  return (
    <p className="text-sm text-ink-800" data-testid="pico-rider">
      Rider: <span className="font-medium">{s.rider?.name ?? "Assigned"}</span>
      {s.rider?.phone ? (
        <>
          {" "}·{" "}
          <a className="font-medium text-kesari-700 hover:underline" href={`tel:+91${s.rider.phone}`}>
            {s.rider.phone}
          </a>
        </>
      ) : null}
    </p>
  );
}

function EtaLine({ s }: { s: PicoShipment }) {
  if (!s.live) return s.deliveredAtIst ? <p className="text-sm text-ink-700">Delivered {s.deliveredAtIst}</p> : null;
  const parts: string[] = [];
  if (s.pickupEtaMin != null) parts.push(`pickup in about ${s.pickupEtaMin} min`);
  if (s.etaIst) parts.push(`expected ${s.etaIst}`);
  else if (s.deliveryEtaMin != null) parts.push(`delivery in about ${s.deliveryEtaMin} min`);
  return parts.length ? <p className="text-sm text-ink-700">ETA: {parts.join(" · ")}</p> : null;
}

/* ------------------------------------------------------------------ shop */

export function PicoShipmentCard({ orderId, onChanged }: { orderId: string; onChanged?: () => void }) {
  const { data, error, reload } = usePico(orderId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const s = data?.shipment ?? null;

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setFailure(null);
    setMessage(null);
    try {
      await call(`/api/orders/${orderId}/pico`, { method: "POST", body: JSON.stringify(body) });
      setMessage(done);
      reload();
      onChanged?.();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Could not do that.");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!s) return null;
  return (
    <div className="mt-2 rounded-lg border border-leaf-300 bg-white p-3 text-sm" data-testid="pico-shipment">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-ink-900">
          gokesari.com delivery partner · <span data-testid="pico-status">{s.statusLabel}</span>
        </p>
        <Badge tone={s.bookingFailed ? "danger" : s.live ? "info" : "success"}>AWB {s.awbNumber}</Badge>
      </div>
      {s.pickupCode ? (
        <p className="mt-2 rounded-md bg-cream-50 px-3 py-2" data-testid="pico-pickup-code">
          Pickup code: <span className="font-mono text-lg font-semibold tracking-widest">{s.pickupCode}</span>
          <span className="block text-xs text-ink-600">Hand over the parcel only after the rider tells you this code.</span>
        </p>
      ) : null}
      <div className="mt-2 space-y-1">
        <RiderLine s={s} />
        <EtaLine s={s} />
        {s.paymentType === "COD" ? <p className="text-xs text-ink-600">Rider collects {formatPaise(s.collectiblePaise)} cash from the customer.</p> : null}
        {s.lastReason && (s.bookingFailed || s.status === "ATTEMPTED_UNDELIVERED" || s.unconfirmed) ? <p className="text-xs text-red-700">{s.lastReason}</p> : null}
        {s.trackingUrl ? (
          <a className="text-sm font-medium text-kesari-700 hover:underline" href={s.trackingUrl} target="_blank" rel="noopener noreferrer">
            Track →
          </a>
        ) : null}
      </div>
      <Timeline entries={s.timeline} />
      <div className="mt-2 flex flex-wrap gap-2">
        {s.unconfirmed || s.bookingFailed ? (
          <Button size="sm" disabled={busy} onClick={() => void act({ action: "book" }, "Booked with the delivery partner.")}>
            Book again
          </Button>
        ) : null}
        {s.cancellable && !s.bookingFailed ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              const reason = window.prompt("Why cancel the delivery partner? (the order stays with you; choose another delivery option after this)", "Shop cannot fulfil the order");
              if (reason && reason.trim().length >= 3) void act({ action: "cancel", reason: reason.trim() }, "The delivery partner booking is cancelled.");
            }}
          >
            Cancel delivery partner
          </Button>
        ) : null}
      </div>
      {message ? <p className="mt-2 text-xs text-leaf-700">{message}</p> : null}
      {failure ? (
        <div className="mt-2">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- customer */

export function PicoCustomerCard({ orderId }: { orderId: string }) {
  const { data } = usePico(orderId);
  const s = data?.shipment ?? null;
  if (!s) return null;
  return (
    <div className="mt-3 space-y-2 border-t border-cream-100 pt-3 text-sm" data-testid="pico-customer">
      <p className="text-ink-800">
        Delivered by <span className="font-semibold">gokesari.com delivery partner</span> · <span data-testid="pico-status">{s.statusLabel}</span>
      </p>
      {s.deliveryCode ? (
        <p className="rounded-md bg-cream-50 px-3 py-2" data-testid="pico-delivery-code">
          Your delivery code: <span className="font-mono text-lg font-semibold tracking-widest">{s.deliveryCode}</span>
          <span className="block text-xs text-ink-600">Give it to the rider only when you have the parcel in hand.</span>
        </p>
      ) : null}
      <RiderLine s={s} />
      <EtaLine s={s} />
      {s.paymentType === "COD" && s.live ? <p className="text-xs text-ink-600">Pay {formatPaise(s.collectiblePaise)} in cash to the rider.</p> : null}
      {s.status === "ATTEMPTED_UNDELIVERED" && s.lastReason ? <p className="text-xs text-red-700">Delivery attempted: {s.lastReason}</p> : null}
      {s.trackingUrl && s.live ? (
        <a className="inline-flex min-h-11 items-center font-medium text-kesari-700 hover:underline" href={s.trackingUrl} target="_blank" rel="noopener noreferrer">
          Track on the delivery partner&apos;s page →
        </a>
      ) : null}
      <Timeline entries={s.timeline} />
      {s.live ? <TrackDeliveryButton orderId={orderId} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------ operations */

export function PicoOpsActions({ orderId, reasons, cancellable }: { orderId: string; reasons: string[]; cancellable: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState(reasons[0] ?? "");
  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await call(`/api/orders/${orderId}/pico`, { method: "POST", body: JSON.stringify(body) });
      setMsg(done);
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not do that.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act({ action: "refresh" }, "Status refreshed from the delivery partner.")}>
        Refresh status
      </Button>
      {cancellable ? (
        <>
          <select className="rounded-lg border border-cream-200 bg-white px-2 py-1 text-xs" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Cancel reason">
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="danger"
            disabled={busy || !reason}
            onClick={() => {
              if (window.confirm(`Cancel this shipment with the delivery partner?\nReason: ${reason}`)) void act({ action: "cancel", reason }, "Cancelled.");
            }}
          >
            Cancel shipment
          </Button>
        </>
      ) : null}
      {msg ? <span className="text-xs text-leaf-700">{msg}</span> : null}
      {err ? <span className="text-xs text-red-700">{err}</span> : null}
    </div>
  );
}

export function PicoRefillButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const r = await call<{ added: number; problem?: string }>("/api/admin/delivery/pico", { method: "POST", body: JSON.stringify({ action: "refill" }) });
            setMsg(r.problem ?? `${r.added} AWB numbers added.`);
            window.location.reload();
          } catch (e) {
            setMsg(e instanceof Error ? e.message : "Refill failed.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Refill AWB pool now
      </Button>
      {msg ? <span className="text-xs text-ink-600">{msg}</span> : null}
    </span>
  );
}
