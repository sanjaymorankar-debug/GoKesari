"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

export interface AdminCharge {
  serviceKey: string;
  version: number;
  chargeModel: "FREE" | "PER_REQUEST" | "PER_ITEM" | "PER_BATCH";
  amountPaise: number;
  batchSize: number | null;
  gstApplicable: boolean;
  gstRateBp: number;
  freeQuotaPerMonth: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
  changeReason: string | null;
}

export interface AdminRequest {
  id: string;
  receiptNumber: string;
  shopName: string;
  serviceKey: string;
  quantity: number;
  totalPaise: number;
  refundPaise: number;
  status: string;
  paymentMethod: string | null;
  ticketNumber: string | null;
  ticketStatus: string | null;
  createdAt: string;
}

export interface AdminSummary {
  serviceKey: string;
  requests: number;
  paidPaise: number;
  refundedPaise: number;
  resolved: number;
  withinSla: number;
}

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const LABEL: Record<string, string> = { GENERAL: "General support", PRODUCT_UPLOAD: "Product upload", PRICE_UPDATE: "Price update" };
const MODELS = { FREE: "Free", PER_REQUEST: "Per request", PER_ITEM: "Per item", PER_BATCH: "Per batch" } as const;

async function post(body: unknown) {
  const res = await fetch("/api/admin/support-services", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const p = await res.json().catch(() => null);
  if (!res.ok) throw new Error(p?.error?.message ?? "That did not work.");
  return p;
}

function ChargeEditor({ charge, serviceKey, onSaved, onError }: { charge: AdminCharge | null; serviceKey: string; onSaved: (m: string) => void; onError: (m: string) => void }) {
  const [model, setModel] = useState<AdminCharge["chargeModel"]>(charge?.chargeModel ?? "FREE");
  const [amount, setAmount] = useState(charge ? String(charge.amountPaise / 100) : "0");
  const [batch, setBatch] = useState(String(charge?.batchSize ?? 50));
  const [gst, setGst] = useState(charge?.gstApplicable ?? true);
  const [gstRate, setGstRate] = useState(String((charge?.gstRateBp ?? 1800) / 100));
  const [quota, setQuota] = useState(String(charge?.freeQuotaPerMonth ?? 0));
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await post({
        action: "saveCharge",
        serviceKey,
        reason,
        charge: {
          chargeModel: model,
          amountPaise: Math.round(Number(amount) * 100),
          batchSize: model === "PER_BATCH" ? Number(batch) : null,
          gstApplicable: gst,
          gstRateBp: Math.round(Number(gstRate) * 100),
          freeQuotaPerMonth: Number(quota),
          effectiveFrom: from,
        },
      });
      setReason("");
      onSaved(`${LABEL[serviceKey]}: new charge saved. Requests already made keep their price.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid={`charge-${serviceKey}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-bold text-ink-900">{LABEL[serviceKey]}</h3>
        {charge ? <Badge tone="info">version {charge.version} · from {charge.effectiveFrom}</Badge> : <Badge tone="warning">no charge</Badge>}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Charge">
          <select className={inputClass} value={model} onChange={(e) => setModel(e.target.value as AdminCharge["chargeModel"])} aria-label={`${LABEL[serviceKey]} charge model`}>
            {Object.entries(MODELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        {model !== "FREE" ? (
          <Field label="Amount (₹, before GST)">
            <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={`${LABEL[serviceKey]} amount`} />
          </Field>
        ) : null}
        {model === "PER_BATCH" ? (
          <Field label="Items per batch">
            <input className={inputClass} inputMode="numeric" value={batch} onChange={(e) => setBatch(e.target.value.replace(/\D/g, ""))} aria-label={`${LABEL[serviceKey]} batch size`} />
          </Field>
        ) : null}
        {model !== "FREE" ? (
          <>
            <Field label="GST %">
              <span className="flex items-center gap-2">
                <input type="checkbox" className="h-5 w-5" checked={gst} onChange={(e) => setGst(e.target.checked)} aria-label={`${LABEL[serviceKey]} GST applies`} />
                <input className={inputClass} inputMode="decimal" value={gstRate} disabled={!gst} onChange={(e) => setGstRate(e.target.value)} aria-label={`${LABEL[serviceKey]} GST rate`} />
              </span>
            </Field>
            <Field label="Free requests each month">
              <input className={inputClass} inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value.replace(/\D/g, ""))} aria-label={`${LABEL[serviceKey]} free quota`} />
            </Field>
          </>
        ) : null}
        <Field label="Effective from">
          <input type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} aria-label={`${LABEL[serviceKey]} effective from`} />
        </Field>
      </div>
      <Field label="Reason for the change" hint="Logged with your name.">
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label={`${LABEL[serviceKey]} reason`} />
      </Field>
      <Button size="sm" disabled={busy || reason.trim().length < 5} onClick={save}>
        {busy ? "Saving…" : "Save new charge"}
      </Button>
    </Card>
  );
}

/**
 * Support services administration (docs/dealer-programme, GKS-SP-001):
 * charges per service (admin, versioned, with a reason), the refund rule,
 * every request with its ticket, refunds, and the report by service.
 * Operators see everything read-only.
 */
export function SupportServicesAdmin({
  isAdmin,
  charges,
  settings,
  requests,
  summary,
}: {
  isAdmin: boolean;
  charges: AdminCharge[];
  settings: { refundPercentBeforeWork: number; freeForManagedBilling: boolean };
  requests: AdminRequest[];
  summary: AdminSummary[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refundPct, setRefundPct] = useState(String(settings.refundPercentBeforeWork));
  const [managedFree, setManagedFree] = useState(settings.freeForManagedBilling);
  const [settingsReason, setSettingsReason] = useState("");
  const active = (key: string) => charges.find((c) => c.serviceKey === key && c.status === "ACTIVE") ?? null;
  const done = (m: string) => {
    setError(null);
    setNotice(m);
    router.refresh();
  };
  const fail = (m: string) => {
    setNotice(null);
    setError(m);
  };

  async function refund(r: AdminRequest) {
    const left = r.totalPaise - r.refundPaise;
    const amount = window.prompt(`Refund to the shop wallet for ${r.receiptNumber} (₹, up to ${(left / 100).toFixed(2)}):`, (left / 100).toFixed(2));
    if (!amount) return;
    const reason = window.prompt("Reason for the refund:") ?? "";
    try {
      await post({ action: "refund", requestId: r.id, amountPaise: Math.round(Number(amount) * 100), reason });
      done(`Refunded ${rs(Math.round(Number(amount) * 100))} for ${r.receiptNumber}.`);
    } catch (e) {
      fail(e instanceof Error ? e.message : "That did not work.");
    }
  }

  return (
    <div className="space-y-6" data-testid="support-services-admin">
      {error ? <Alert tone="danger" title="Could not do that">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-ink-900">Report by service</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead className="text-ink-600">
              <tr>
                <th className="py-1">Service</th>
                <th>Paid requests</th>
                <th>Revenue</th>
                <th>Refunded</th>
                <th>Within SLA</th>
              </tr>
            </thead>
            <tbody>
              {["GENERAL", "PRODUCT_UPLOAD", "PRICE_UPDATE"].map((k) => {
                const s = summary.find((x) => x.serviceKey === k);
                return (
                  <tr key={k} className="border-t border-cream-200">
                    <td className="py-1 font-semibold">{LABEL[k]}</td>
                    <td>{s?.requests ?? 0}</td>
                    <td>{rs(s?.paidPaise ?? 0)}</td>
                    <td>{rs(s?.refundedPaise ?? 0)}</td>
                    <td>{s?.resolved ? `${Math.round((100 * s.withinSla) / s.resolved)}% of ${s.resolved}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {isAdmin ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-ink-900">Charges</h2>
          {["GENERAL", "PRODUCT_UPLOAD", "PRICE_UPDATE"].map((k) => (
            <ChargeEditor key={`${k}-${active(k)?.version ?? 0}`} serviceKey={k} charge={active(k)} onSaved={done} onError={fail} />
          ))}
          <Card className="space-y-3 p-4">
            <h3 className="font-bold text-ink-900">Refunds and managed billing</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Refund when cancelled before work starts (%)">
                <input className={inputClass} inputMode="numeric" value={refundPct} onChange={(e) => setRefundPct(e.target.value.replace(/\D/g, ""))} aria-label="Refund percent" />
              </Field>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" className="h-5 w-5" checked={managedFree} onChange={(e) => setManagedFree(e.target.checked)} />
                Free for shops on managed billing (already billed for this work)
              </label>
            </div>
            <Field label="Reason for the change">
              <input className={inputClass} value={settingsReason} onChange={(e) => setSettingsReason(e.target.value)} maxLength={500} aria-label="Settings reason" />
            </Field>
            <Button
              size="sm"
              disabled={settingsReason.trim().length < 5}
              onClick={async () => {
                try {
                  await post({ action: "settings", reason: settingsReason, patch: { refundPercentBeforeWork: Number(refundPct), freeForManagedBilling: managedFree } });
                  setSettingsReason("");
                  done("Settings saved.");
                } catch (e) {
                  fail(e instanceof Error ? e.message : "That did not work.");
                }
              }}
            >
              Save settings
            </Button>
          </Card>
        </section>
      ) : (
        <Alert tone="info">Charges and refunds are set by an admin. You can see every request and its ticket.</Alert>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-ink-900">Requests</h2>
        {requests.length === 0 ? <p className="text-sm text-ink-500">None yet.</p> : null}
        <ul className="divide-y divide-cream-200 text-sm">
          {requests.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-semibold">{r.shopName}</span> · {LABEL[r.serviceKey] ?? r.serviceKey}
                {r.quantity > 1 ? ` (${r.quantity})` : ""} · {r.totalPaise ? rs(r.totalPaise) : "free"} · {r.receiptNumber} · {r.createdAt.slice(0, 10)}
                {r.ticketNumber ? ` · ticket ${r.ticketNumber}` : ""}
              </span>
              <span className="flex flex-wrap items-center gap-1">
                <Badge tone={r.status === "PAID" ? "success" : r.status === "AWAITING_PAYMENT" ? "warning" : "neutral"}>{r.status.toLowerCase().replace("_", " ")}</Badge>
                {r.refundPaise ? <Badge tone="info">refunded {rs(r.refundPaise)}</Badge> : null}
                {isAdmin && r.status === "PAID" && r.totalPaise > 0 ? (
                  <Button size="sm" variant="secondary" onClick={() => refund(r)}>
                    Refund
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
