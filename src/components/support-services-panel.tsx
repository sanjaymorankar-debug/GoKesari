"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import clsx from "clsx";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

interface Service {
  key: string;
  label: string;
  description: string;
  unitLabel: string | null;
  charge: { chargeModel: string; amountPaise: number; batchSize: number | null; gstApplicable: boolean; gstRateBp: number; freeQuotaPerMonth: number } | null;
}

interface Request {
  id: string;
  receiptNumber: string;
  serviceKey: string;
  quantity: number;
  description: string;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  freeReason: string | null;
  status: string;
  paymentMethod: string | null;
  ticketId: string | null;
  ticketNumber: string | null;
  ticketStatus: string | null;
  refundPaise: number;
  createdAt: string;
  paidAt: string | null;
}

interface Quote {
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  explanation: string;
  freeReason: string | null;
}

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const LABEL: Record<string, string> = { GENERAL: "General support", PRODUCT_UPLOAD: "Product upload", PRICE_UPDATE: "Price update" };

function chargeText(s: Service): string {
  const c = s.charge;
  if (!c || c.chargeModel === "FREE") return "Free";
  const gst = c.gstApplicable ? ` + ${c.gstRateBp / 100}% GST` : "";
  const quota = c.freeQuotaPerMonth ? ` · first ${c.freeQuotaPerMonth} each month free` : "";
  if (c.chargeModel === "PER_BATCH") return `${rs(c.amountPaise)} per ${c.batchSize} ${s.unitLabel ?? "items"}${gst}${quota}`;
  if (c.chargeModel === "PER_ITEM") return `${rs(c.amountPaise)} per ${s.unitLabel?.replace(/s$/, "") ?? "item"}${gst}${quota}`;
  return `${rs(c.amountPaise)} per request${gst}${quota}`;
}

/**
 * Support services (docs/dealer-programme, GKS-SP-001): choose a service, see
 * the price for the quantity before submitting, attach files, pay from the
 * shop wallet or online, then follow the ticket. Cancel before work starts for
 * a refund. The server re-checks every price and payment.
 */
export function SupportServicesPanel({ shopId, shopName, services, requests, canUseWallet }: { shopId: string; shopName: string; services: Service[]; requests: Request[]; canUseWallet: boolean }) {
  const router = useRouter();
  const [serviceKey, setServiceKey] = useState(services[0]?.key ?? "");
  const [quantity, setQuantity] = useState("1");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [quoted, setQuoted] = useState<{ key: string; quote: Quote | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Request | null>(null);
  const service = services.find((s) => s.key === serviceKey);

  const qty = Number(quantity);
  const quoteKey = serviceKey && Number.isInteger(qty) && qty >= 1 ? `${serviceKey}:${qty}` : null;
  // Only the quote for what is on screen now (an older answer is ignored).
  const quote = quoteKey && quoted?.key === quoteKey ? quoted.quote : null;

  useEffect(() => {
    if (!quoteKey) return;
    const ctrl = new AbortController();
    fetch(`/api/support-services/quote?shopId=${shopId}&serviceKey=${serviceKey}&quantity=${qty}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((p) => setQuoted({ key: quoteKey, quote: p?.quote ?? null }))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [shopId, serviceKey, qty, quoteKey]);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  async function json<T>(res: Response): Promise<T> {
    const p = await res.json().catch(() => null);
    if (!res.ok) {
      const short = p?.error?.details?.shortfallPaise;
      throw new Error(short ? `Not enough in your shop wallet: ${rs(short)} short. Top up the wallet or pay online.` : (p?.error?.message ?? "That did not work."));
    }
    return p as T;
  }

  async function submit() {
    const data = new FormData();
    data.set("shopId", shopId);
    data.set("serviceKey", serviceKey);
    data.set("quantity", service?.unitLabel ? quantity : "1");
    data.set("description", description);
    for (const f of files) data.append("files", f);
    const res = await json<{ request: Request }>(await fetch("/api/support-services", { method: "POST", body: data }));
    setDescription("");
    setFiles([]);
    return res.request.status === "PAID" ? "Request received — no payment needed. Our team will pick it up." : "Request saved. Pay below to send it to our team.";
  }

  async function pay(r: Request, method: "WALLET" | "ONLINE") {
    const res = await json<{ checkoutUrl?: string | null }>(await fetch(`/api/support-services/${r.id}/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method }) }));
    if (method === "ONLINE") {
      if (res.checkoutUrl) window.location.assign(res.checkoutUrl);
      return "Opening the payment page…";
    }
    return "Paid from your shop wallet. Our team will pick it up.";
  }

  return (
    <div className="space-y-4" data-testid="support-services">
      {error ? <Alert tone="danger" title="Could not do that">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Service">
        {services.map((s) => (
          <button
            key={s.key}
            type="button"
            role="radio"
            aria-checked={serviceKey === s.key}
            onClick={() => setServiceKey(s.key)}
            className={clsx("rounded-2xl border-2 bg-white p-3 text-left", serviceKey === s.key ? "border-kesari-700" : "border-[var(--gk-line)]")}
            data-testid={`service-${s.key}`}
          >
            <span className="block font-bold text-ink-900">{s.label}</span>
            <span className="mt-1 block text-sm text-ink-700">{s.description}</span>
            <span className="mt-2 block text-sm font-semibold text-kesari-800">{chargeText(s)}</span>
          </button>
        ))}
      </div>

      {service ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-bold text-ink-900">{service.label} for {shopName}</h2>
          {service.unitLabel ? (
            <Field label={`How many ${service.unitLabel}?`}>
              <input className={inputClass} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ""))} maxLength={6} aria-label="Quantity" />
            </Field>
          ) : null}
          <Field label="What do you need?" hint="The more detail, the faster we finish.">
            <textarea className={inputClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} aria-label="Description" />
          </Field>
          <Field label="Files (optional)" hint="Product list (Excel / CSV), photos or a price list. Up to 5 files, 10 MB each.">
            <input
              type="file"
              multiple
              accept=".xlsx,.xlsm,.csv,application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))}
              className="block min-h-11 text-sm"
              aria-label="Files"
            />
          </Field>
          <div className="rounded-xl bg-cream-50 p-3 text-sm" data-testid="support-quote">
            {quote ? (
              <>
                <p className="text-lg font-bold text-ink-900">{quote.totalPaise ? rs(quote.totalPaise) : "Free"}</p>
                <p className="text-ink-700">{quote.explanation}</p>
              </>
            ) : (
              <p className="text-ink-600">Enter the quantity to see the price.</p>
            )}
          </div>
          <Button disabled={busy !== null || description.trim().length < 10} onClick={() => run("submit", submit)}>
            {busy === "submit" ? "Sending…" : quote?.totalPaise ? `Continue to pay ${rs(quote.totalPaise)}` : "Send request"}
          </Button>
        </Card>
      ) : null}

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">Your requests</h2>
        {requests.length === 0 ? <p className="text-sm text-ink-500">None yet.</p> : null}
        <ul className="divide-y divide-cream-200 text-sm" data-testid="support-requests">
          {requests.map((r) => (
            <li key={r.id} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-semibold">{LABEL[r.serviceKey] ?? r.serviceKey}</span>
                  {r.quantity > 1 ? ` · ${r.quantity} products` : ""} · {r.totalPaise ? rs(r.totalPaise) : "free"} · {r.createdAt.slice(0, 10)}
                </span>
                <span className="flex flex-wrap gap-1">
                  <Badge tone={r.status === "PAID" ? "success" : r.status === "AWAITING_PAYMENT" ? "warning" : "neutral"}>{r.status.toLowerCase().replace("_", " ")}</Badge>
                  {r.ticketStatus ? <Badge tone="info">ticket {r.ticketStatus.toLowerCase().replace("_", " ")}</Badge> : null}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {r.status === "AWAITING_PAYMENT" ? (
                  <>
                    {canUseWallet ? (
                      <Button size="sm" disabled={busy !== null} onClick={() => run(`pay-${r.id}`, () => pay(r, "WALLET"))}>
                        Pay from shop wallet
                      </Button>
                    ) : null}
                    <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run(`pay-${r.id}`, () => pay(r, "ONLINE"))}>
                      Pay online (UPI / card)
                    </Button>
                  </>
                ) : null}
                {r.ticketId ? (
                  <Link href={`/support/${r.ticketId}`} className="inline-flex min-h-11 items-center text-kesari-800 underline">
                    Ticket {r.ticketNumber}
                  </Link>
                ) : null}
                {r.status === "PAID" || r.status === "REFUNDED" ? (
                  <button type="button" className="min-h-11 text-kesari-800 underline" onClick={() => setReceipt(r)}>
                    Receipt
                  </button>
                ) : null}
                {r.status === "AWAITING_PAYMENT" || (r.status === "PAID" && (!r.ticketStatus || ["OPEN", "ACKNOWLEDGED"].includes(r.ticketStatus))) ? (
                  <button
                    type="button"
                    className="min-h-11 text-ink-600 underline"
                    disabled={busy !== null}
                    onClick={() => {
                      if (!window.confirm(r.status === "PAID" ? "Cancel this request? Work has not started, so you get a refund." : "Cancel this request?")) return;
                      void run(`cancel-${r.id}`, async () => {
                        await json(await fetch(`/api/support-services/${r.id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "cancelled by the shop" }) }));
                        return "Cancelled.";
                      });
                    }}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {receipt ? (
        <Card className="space-y-1 p-4 text-sm" data-testid="support-receipt">
          <h2 className="text-base font-bold text-ink-900">Receipt {receipt.receiptNumber}</h2>
          <p>
            {LABEL[receipt.serviceKey]}
            {receipt.quantity > 1 ? ` — ${receipt.quantity} products` : ""} for {shopName}
          </p>
          <p>Amount {rs(receipt.basePaise)} · GST {rs(receipt.gstPaise)} · Total {rs(receipt.totalPaise)}</p>
          <p>
            Paid {receipt.paidAt?.slice(0, 10) ?? ""} by {receipt.paymentMethod?.toLowerCase() ?? "—"}
            {receipt.refundPaise ? ` · refunded ${rs(receipt.refundPaise)}` : ""}
          </p>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="secondary" onClick={() => window.print()}>
              Print
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReceipt(null)}>
              Close
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
