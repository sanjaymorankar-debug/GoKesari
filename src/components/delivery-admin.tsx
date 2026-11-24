"use client";

/**
 * Admin → Delivery management (docs/hdms-2026-11): the small forms and buttons behind the server pages.
 * Every action calls an /api/admin/delivery/* route; the page refreshes on success.
 */
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";

function useSend() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function send(url: string, method: string, body: unknown, okText?: string): Promise<unknown> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not save.");
      if (okText) setNotice(okText);
      router.refresh();
      return payload;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  const messages = (
    <>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <p className="text-sm text-leaf-700">{notice}</p> : null}
    </>
  );
  return { send, busy, messages };
}

const rupees = (paise: number | null | undefined) => (paise == null ? "" : String(paise / 100));
const toPaise = (v: string) => Math.round(Number(v || "0") * 100);

/* ---------------------------------------------------------------- buttons */

export function ActionButton({
  url,
  body,
  label,
  confirm,
  variant = "secondary",
  method = "POST",
}: {
  url: string;
  body: unknown;
  label: string;
  confirm?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  method?: string;
}) {
  const { send, busy, messages } = useSend();
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        size="sm"
        variant={variant}
        disabled={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          await send(url, method, body, "Done.");
        }}
      >
        {label}
      </Button>
      {messages}
    </span>
  );
}

/** Cancel with a reason (bookings). */
export function ReasonAction({ url, label, action }: { url: string; label: string; action: string }) {
  const { send, busy, messages } = useSend();
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        await send(url, "POST", { action, reason }, "Done.");
      }}
    >
      <Field label="Reason">
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={200} required />
      </Field>
      <Button size="sm" variant="danger" type="submit" disabled={busy}>
        {label}
      </Button>
      {messages}
    </form>
  );
}

export function SimulateEvent({ bookingId }: { bookingId: string }) {
  const { send, busy, messages } = useSend();
  const [status, setStatus] = useState("PICKED_UP");
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Sandbox event">
        <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
          {["AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "DELIVERED", "FAILED", "RETURNING", "RETURNED", "CANCELLED"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Field>
      <Button size="sm" disabled={busy} onClick={() => void send(`/api/admin/delivery/bookings/${bookingId}`, "POST", { action: "simulate", status }, "Event sent.")}>
        Simulate
      </Button>
      {messages}
    </div>
  );
}

export function AllocateOrder() {
  const { send, busy, messages } = useSend();
  const [orderId, setOrderId] = useState("");
  const [partnersOnly, setPartnersOnly] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = (await send(`/api/admin/delivery/orders/${orderId.trim()}/allocate`, "POST", { partnersOnly })) as { outcome: string; detail: string } | null;
        if (r) setResult(`${r.outcome}: ${r.detail}`);
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Order id (ready orders only)">
          <input className={inputClass} value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="uuid" required />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={partnersOnly} onChange={(e) => setPartnersOnly(e.target.checked)} /> Delivery partners only
        </label>
        <Button size="sm" type="submit" disabled={busy}>
          Allocate now
        </Button>
      </div>
      {result ? <p className="text-sm text-ink-700">{result}</p> : null}
      {messages}
    </form>
  );
}

/* --------------------------------------------------------------- providers */

export interface ProviderFormValue {
  code: string;
  name: string;
  enabled: boolean;
  environment: "SANDBOX" | "PRODUCTION";
  priority: number;
  baseUrl: string | null;
  timeoutMs: number;
  reliabilityPercent: number;
  integrated: boolean;
  capabilities: { maxDistanceKm?: number; maxWeightKg?: number; refrigerated?: boolean; sandboxOnly?: boolean };
  hasCredentials: boolean;
  hasWebhookSecret: boolean;
  circuitState: string;
}

export function ProviderForm({ p, canEdit }: { p: ProviderFormValue; canEdit: boolean }) {
  const { send, busy, messages } = useSend();
  const [v, setV] = useState({
    enabled: p.enabled,
    environment: p.environment,
    priority: String(p.priority),
    baseUrl: p.baseUrl ?? "",
    timeoutMs: String(p.timeoutMs),
    reliabilityPercent: String(p.reliabilityPercent),
    maxDistanceKm: p.capabilities.maxDistanceKm != null ? String(p.capabilities.maxDistanceKm) : "",
    maxWeightKg: p.capabilities.maxWeightKg != null ? String(p.capabilities.maxWeightKg) : "",
    refrigerated: Boolean(p.capabilities.refrigerated),
    apiKey: "",
    webhookSecret: "",
  });
  const set = (k: keyof typeof v, val: string | boolean) => setV((x) => ({ ...x, [k]: val }));
  if (!canEdit) return null;
  return (
    <form
      className="grid gap-3 sm:grid-cols-3"
      onSubmit={async (e) => {
        e.preventDefault();
        await send(
          `/api/admin/delivery/providers/${p.code}`,
          "PATCH",
          {
            enabled: v.enabled,
            environment: v.environment,
            priority: Number(v.priority),
            baseUrl: v.baseUrl || null,
            timeoutMs: Number(v.timeoutMs),
            reliabilityPercent: Number(v.reliabilityPercent),
            maxDistanceKm: v.maxDistanceKm ? Number(v.maxDistanceKm) : null,
            maxWeightKg: v.maxWeightKg ? Number(v.maxWeightKg) : null,
            refrigerated: v.refrigerated,
            ...(v.apiKey ? { credentials: { apiKey: v.apiKey } } : {}),
            ...(v.webhookSecret ? { webhookSecret: v.webhookSecret } : {}),
          },
          "Saved.",
        );
        setV((x) => ({ ...x, apiKey: "", webhookSecret: "" }));
      }}
    >
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={v.enabled} disabled={!p.integrated} onChange={(e) => set("enabled", e.target.checked)} /> Enabled
        {!p.integrated ? <span className="text-xs text-ink-500">(not integrated yet)</span> : null}
      </label>
      <Field label="Environment">
        <select className={inputClass} value={v.environment} onChange={(e) => set("environment", e.target.value)} disabled={p.capabilities.sandboxOnly}>
          <option value="SANDBOX">Sandbox</option>
          <option value="PRODUCTION">Production</option>
        </select>
      </Field>
      <Field label="Priority (lower first on ties)">
        <input className={inputClass} type="number" min={1} max={1000} value={v.priority} onChange={(e) => set("priority", e.target.value)} />
      </Field>
      <Field label="API base URL (https)">
        <input className={inputClass} value={v.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="from the partner's API document" />
      </Field>
      <Field label="Timeout (ms)">
        <input className={inputClass} type="number" min={500} max={60000} value={v.timeoutMs} onChange={(e) => set("timeoutMs", e.target.value)} />
      </Field>
      <Field label="Reliability (%)">
        <input className={inputClass} type="number" min={0} max={100} value={v.reliabilityPercent} onChange={(e) => set("reliabilityPercent", e.target.value)} />
      </Field>
      <Field label="Max distance (km)">
        <input className={inputClass} type="number" step="0.5" value={v.maxDistanceKm} onChange={(e) => set("maxDistanceKm", e.target.value)} />
      </Field>
      <Field label="Max weight (kg)">
        <input className={inputClass} type="number" step="0.5" value={v.maxWeightKg} onChange={(e) => set("maxWeightKg", e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={v.refrigerated} onChange={(e) => set("refrigerated", e.target.checked)} /> Refrigerated delivery
      </label>
      <Field label={`API key / token ${p.hasCredentials ? "(set — type to replace)" : "(not set)"}`}>
        <input className={inputClass} type="password" autoComplete="off" value={v.apiKey} onChange={(e) => set("apiKey", e.target.value)} />
      </Field>
      <Field label={`Webhook secret ${p.hasWebhookSecret ? "(set — type to replace)" : "(not set)"}`}>
        <input className={inputClass} type="password" autoComplete="off" value={v.webhookSecret} onChange={(e) => set("webhookSecret", e.target.value)} />
      </Field>
      <div className="flex items-end gap-2">
        <Button size="sm" type="submit" disabled={busy}>
          Save
        </Button>
        {p.circuitState === "OPEN" ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void send(`/api/admin/delivery/providers/${p.code}`, "PATCH", { resetCircuit: true }, "Circuit reset.")}>
            Reset circuit
          </Button>
        ) : null}
      </div>
      <div className="sm:col-span-3">{messages}</div>
    </form>
  );
}

/* ------------------------------------------------------------------ zones */

export interface ZoneFormValue {
  id?: string;
  code: string;
  name: string;
  city: string;
  centerLat: string;
  centerLng: string;
  radiusM: number;
  maxDeliveryKm: string;
  polygon: [number, number][] | null;
}

export function ZoneForm({ zone }: { zone?: ZoneFormValue }) {
  const { send, busy, messages } = useSend();
  const [v, setV] = useState({
    code: zone?.code ?? "PUN-",
    name: zone?.name ?? "",
    city: zone?.city ?? "Pune",
    centerLat: zone?.centerLat ?? "",
    centerLng: zone?.centerLng ?? "",
    radiusM: String(zone?.radiusM ?? 3000),
    maxDeliveryKm: zone?.maxDeliveryKm ?? "6",
    polygon: zone?.polygon ? JSON.stringify(zone.polygon) : "",
  });
  const set = (k: keyof typeof v, val: string) => setV((x) => ({ ...x, [k]: val }));
  return (
    <form
      className="grid gap-2 sm:grid-cols-4"
      onSubmit={async (e) => {
        e.preventDefault();
        let polygon: [number, number][] | null = null;
        if (v.polygon.trim()) {
          try {
            polygon = JSON.parse(v.polygon);
          } catch {
            window.alert("Polygon must be JSON: [[lat,lng],[lat,lng],...]");
            return;
          }
        }
        await send(
          zone?.id ? `/api/admin/delivery/zones/${zone.id}` : "/api/admin/delivery/zones",
          zone?.id ? "PUT" : "POST",
          { code: v.code, name: v.name, city: v.city, centerLat: Number(v.centerLat), centerLng: Number(v.centerLng), radiusM: Number(v.radiusM), maxDeliveryKm: Number(v.maxDeliveryKm), polygon },
          "Saved.",
        );
      }}
    >
      <Field label="Code">
        <input className={inputClass} value={v.code} onChange={(e) => set("code", e.target.value)} required />
      </Field>
      <Field label="Name">
        <input className={inputClass} value={v.name} onChange={(e) => set("name", e.target.value)} required />
      </Field>
      <Field label="City">
        <input className={inputClass} value={v.city} onChange={(e) => set("city", e.target.value)} required />
      </Field>
      <Field label="Max delivery (km)">
        <input className={inputClass} type="number" step="0.5" value={v.maxDeliveryKm} onChange={(e) => set("maxDeliveryKm", e.target.value)} required />
      </Field>
      <Field label="Centre latitude">
        <input className={inputClass} value={v.centerLat} onChange={(e) => set("centerLat", e.target.value)} required />
      </Field>
      <Field label="Centre longitude">
        <input className={inputClass} value={v.centerLng} onChange={(e) => set("centerLng", e.target.value)} required />
      </Field>
      <Field label="Radius (m)">
        <input className={inputClass} type="number" value={v.radiusM} onChange={(e) => set("radiusM", e.target.value)} required />
      </Field>
      <Field label="Polygon (optional JSON)">
        <input className={inputClass} value={v.polygon} onChange={(e) => set("polygon", e.target.value)} placeholder="[[18.55,73.78],...]" />
      </Field>
      <div className="sm:col-span-4 flex items-center gap-3">
        <Button size="sm" type="submit" disabled={busy}>
          {zone?.id ? "Save zone" : "Add zone"}
        </Button>
        {messages}
      </div>
    </form>
  );
}

export function ZoneSuspend({ zoneId, suspended }: { zoneId: string; suspended: boolean }) {
  const { send, busy, messages } = useSend();
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("");
  if (suspended) {
    return (
      <span className="inline-flex flex-col gap-1">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void send(`/api/admin/delivery/zones/${zoneId}`, "POST", { action: "resume" }, "Resumed.")}>
          Resume
        </Button>
        {messages}
      </span>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        await send(`/api/admin/delivery/zones/${zoneId}`, "POST", { action: "suspend", reason, hours: hours ? Number(hours) : null }, "Suspended.");
      }}
    >
      <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (rain, festival…)" minLength={3} required aria-label="Suspension reason" />
      <input className={`${inputClass} w-24`} type="number" min={1} max={720} value={hours} onChange={(e) => setHours(e.target.value)} placeholder="hours" aria-label="Hours" />
      <Button size="sm" variant="danger" type="submit" disabled={busy}>
        Suspend
      </Button>
      {messages}
    </form>
  );
}

/* ---------------------------------------------------------------- pricing */

export interface PricingFormValue {
  id?: string;
  name: string;
  zoneId: string | null;
  active: boolean;
  priority: number;
  commercialModel: string;
  minFeePaise: number;
  baseKm: string;
  perKmPaise: number;
  freeWeightGrams: number;
  perKgPaise: number;
  expressSurchargePaise: number;
  peakSurchargePaise: number;
  peakWindows: { from: string; to: string }[];
  freeAbovePaise: number | null;
  shopSharePercent: number;
  gokesariSubsidyPaise: number;
  promoDiscountPaise: number;
  maxFeePaise: number | null;
}

const MODELS: [string, string][] = [
  ["CUSTOMER_PAYS", "Customer pays"],
  ["SHOP_PAYS", "Shop pays"],
  ["SHARED", "Customer and shop share"],
  ["GOKESARI_SPONSORED", "GoKesari sponsors"],
  ["FREE_ABOVE_BASKET", "Free above basket value"],
];

export function PricingForm({ rule, zones }: { rule?: PricingFormValue; zones: { id: string; name: string }[] }) {
  const { send, busy, messages } = useSend();
  const [v, setV] = useState({
    name: rule?.name ?? "",
    zoneId: rule?.zoneId ?? "",
    active: rule?.active ?? true,
    priority: String(rule?.priority ?? 100),
    commercialModel: rule?.commercialModel ?? "CUSTOMER_PAYS",
    minFee: rupees(rule?.minFeePaise ?? 2000),
    baseKm: rule?.baseKm ?? "2",
    perKm: rupees(rule?.perKmPaise ?? 800),
    freeWeightKg: String((rule?.freeWeightGrams ?? 5000) / 1000),
    perKg: rupees(rule?.perKgPaise ?? 500),
    express: rupees(rule?.expressSurchargePaise ?? 1000),
    peak: rupees(rule?.peakSurchargePaise ?? 1000),
    peakWindows: (rule?.peakWindows ?? [{ from: "18:00", to: "21:00" }]).map((w) => `${w.from}-${w.to}`).join(", "),
    freeAbove: rupees(rule?.freeAbovePaise),
    shopShare: String(rule?.shopSharePercent ?? 50),
    subsidy: rupees(rule?.gokesariSubsidyPaise ?? 0),
    promo: rupees(rule?.promoDiscountPaise ?? 0),
    maxFee: rupees(rule?.maxFeePaise),
  });
  const set = (k: keyof typeof v, val: string | boolean) => setV((x) => ({ ...x, [k]: val }));
  const num = (label: string, k: keyof typeof v, step = "0.01"): ReactNode => (
    <Field label={label}>
      <input className={inputClass} type="number" step={step} min={0} value={v[k] as string} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  return (
    <form
      className="grid gap-2 sm:grid-cols-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const peakWindows = v.peakWindows
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const [from, to] = s.split("-").map((x) => x.trim());
            return { from, to };
          });
        await send(
          rule?.id ? `/api/admin/delivery/pricing/${rule.id}` : "/api/admin/delivery/pricing",
          rule?.id ? "PUT" : "POST",
          {
            name: v.name,
            zoneId: v.zoneId || null,
            active: v.active,
            priority: Number(v.priority),
            commercialModel: v.commercialModel,
            minFeePaise: toPaise(v.minFee),
            baseKm: Number(v.baseKm),
            perKmPaise: toPaise(v.perKm),
            freeWeightGrams: Math.round(Number(v.freeWeightKg || "0") * 1000),
            perKgPaise: toPaise(v.perKg),
            expressSurchargePaise: toPaise(v.express),
            peakSurchargePaise: toPaise(v.peak),
            peakWindows,
            freeAbovePaise: v.freeAbove ? toPaise(v.freeAbove) : null,
            shopSharePercent: Number(v.shopShare),
            gokesariSubsidyPaise: toPaise(v.subsidy),
            promoDiscountPaise: toPaise(v.promo),
            maxFeePaise: v.maxFee ? toPaise(v.maxFee) : null,
            validFrom: null,
            validUntil: null,
          },
          "Saved.",
        );
      }}
    >
      <Field label="Name">
        <input className={inputClass} value={v.name} onChange={(e) => set("name", e.target.value)} required />
      </Field>
      <Field label="Zone">
        <select className={inputClass} value={v.zoneId} onChange={(e) => set("zoneId", e.target.value)}>
          <option value="">Every zone</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Who pays">
        <select className={inputClass} value={v.commercialModel} onChange={(e) => set("commercialModel", e.target.value)}>
          {MODELS.map(([m, l]) => (
            <option key={m} value={m}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Priority (lower wins)">
        <input className={inputClass} type="number" value={v.priority} onChange={(e) => set("priority", e.target.value)} />
      </Field>
      {num("Minimum fee (₹)", "minFee")}
      {num("Included km", "baseKm", "0.5")}
      {num("Per extra km (₹)", "perKm")}
      {num("Max fee (₹, blank = none)", "maxFee")}
      {num("Free weight (kg)", "freeWeightKg", "0.5")}
      {num("Per extra kg (₹)", "perKg")}
      {num("Express surcharge (₹)", "express")}
      {num("Peak surcharge (₹)", "peak")}
      <Field label="Peak hours (IST), e.g. 08:00-10:00, 18:00-21:00">
        <input className={inputClass} value={v.peakWindows} onChange={(e) => set("peakWindows", e.target.value)} />
      </Field>
      {num("Free above basket (₹)", "freeAbove")}
      {num("Shop share (%) when shared", "shopShare", "1")}
      {num("GoKesari subsidy (₹)", "subsidy")}
      {num("Promotional discount (₹)", "promo")}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={v.active} onChange={(e) => set("active", e.target.checked)} /> Active
      </label>
      <div className="sm:col-span-4 flex items-center gap-3">
        <Button size="sm" type="submit" disabled={busy}>
          {rule?.id ? "Save rule" : "Add rule"}
        </Button>
        {messages}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------ settlements */

export function CreateSettlement({ providers }: { providers: { code: string; name: string }[] }) {
  const { send, busy, messages } = useSend();
  const [v, setV] = useState({ providerCode: providers[0]?.code ?? "", periodStart: "", periodEnd: "" });
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        await send("/api/admin/delivery/settlements", "POST", v, "Settlement created.");
      }}
    >
      <Field label="Partner">
        <select className={inputClass} value={v.providerCode} onChange={(e) => setV({ ...v, providerCode: e.target.value })}>
          {providers.map((p) => (
            <option key={p.code} value={p.code}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="From">
        <input className={inputClass} type="date" value={v.periodStart} onChange={(e) => setV({ ...v, periodStart: e.target.value })} required />
      </Field>
      <Field label="To">
        <input className={inputClass} type="date" value={v.periodEnd} onChange={(e) => setV({ ...v, periodEnd: e.target.value })} required />
      </Field>
      <Button size="sm" type="submit" disabled={busy}>
        Create
      </Button>
      {messages}
    </form>
  );
}

export function ReconcileSettlement({ settlementId, status }: { settlementId: string; status: string }) {
  const { send, busy, messages } = useSend();
  const [csv, setCsv] = useState("");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [paidRef, setPaidRef] = useState("");
  if (status === "PAID") return null;
  return (
    <div className="space-y-2">
      <form
        className="space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          await send(`/api/admin/delivery/settlements/${settlementId}`, "POST", { action: "reconcile", invoiceCsv: csv, invoiceRef: invoiceRef || null }, "Reconciled.");
        }}
      >
        <Field label="Partner invoice lines (reference,amount in ₹ — one per line)">
          <textarea className={inputClass} rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} required />
        </Field>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Invoice number">
            <input className={inputClass} value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} />
          </Field>
          <Button size="sm" type="submit" disabled={busy}>
            Reconcile
          </Button>
        </div>
      </form>
      {status === "RECONCILED" || status === "DISPUTED" ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await send(`/api/admin/delivery/settlements/${settlementId}`, "POST", { action: "paid", paidRef }, "Marked paid.");
          }}
        >
          <Field label="Payment reference (UTR)">
            <input className={inputClass} value={paidRef} onChange={(e) => setPaidRef(e.target.value)} minLength={3} required />
          </Field>
          <Button size="sm" variant="secondary" type="submit" disabled={busy}>
            Mark paid
          </Button>
        </form>
      ) : null}
      {messages}
    </div>
  );
}
