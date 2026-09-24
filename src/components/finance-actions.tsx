"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";
import { rupeesToPaise } from "@/lib/money";

/** Shared fetch + error handling for the finance console controls. */
function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function send(url: string, method: string, body: unknown, success: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice(success);
      router.refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, send };
}

function Messages({ error, notice }: { error: string | null; notice: string | null }) {
  if (error) {
    return (
      <div className="mt-2">
        <Alert tone="danger">{error}</Alert>
      </div>
    );
  }
  if (notice) return <p className="mt-2 text-xs text-leaf-700">{notice}</p>;
  return null;
}

/** "Prepare last week" for shop settlements or rider payouts (weekly batches). */
export function PrepareBatchButton({ kind }: { kind: "settlements" | "rider-payouts" }) {
  const { busy, error, notice, send } = useAction();
  return (
    <div>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => send(`/api/finance/${kind}`, "POST", {}, "Prepared — review the new batches below.")}
      >
        Prepare last week&apos;s {kind === "settlements" ? "settlements" : "payouts"}
      </Button>
      <Messages error={error} notice={notice} />
    </div>
  );
}

/**
 * Lifecycle buttons for one settlement or payout:
 * PENDING → approve · ELIGIBLE → send to bank · PROCESSING → paid (reference)
 * or failed (reason) · FAILED → re-send · PAID → reversed (reason) ·
 * PENDING/ELIGIBLE → cancel.
 */
export function BatchActions({
  kind,
  id,
  status,
}: {
  kind: "settlements" | "rider-payouts";
  id: string;
  status: string;
}) {
  const { busy, error, send } = useAction();
  const [note, setNote] = useState("");
  const url = `/api/finance/${kind}/${id}`;
  const act = (action: string, label: string) => send(url, "PATCH", { action, note: note.trim() || undefined }, label);
  const needsNote = status === "PROCESSING" || status === "PAID";

  if (status === "CANCELLED" || status === "REVERSED") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {needsNote ? (
        <input
          className="w-40 rounded-lg border border-cream-200 px-2 py-1 text-xs"
          placeholder={status === "PROCESSING" ? "UTR ref or failure reason" : "Reversal reason"}
          aria-label="Bank reference or reason"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      ) : null}
      {status === "PENDING" ? (
        <Button size="sm" disabled={busy} onClick={() => act("approve", "Approved")}>
          Approve
        </Button>
      ) : null}
      {status === "ELIGIBLE" || status === "FAILED" ? (
        <Button size="sm" disabled={busy} onClick={() => act("process", "Marked as sent to bank")}>
          {status === "FAILED" ? "Re-send to bank" : "Sent to bank"}
        </Button>
      ) : null}
      {status === "PROCESSING" ? (
        <>
          <Button size="sm" disabled={busy || note.trim().length < 4} onClick={() => act("pay", "Marked paid")}>
            Mark paid
          </Button>
          <Button size="sm" variant="secondary" disabled={busy || note.trim().length < 4} onClick={() => act("fail", "Marked failed")}>
            Bank rejected
          </Button>
        </>
      ) : null}
      {status === "PAID" ? (
        <Button size="sm" variant="ghost" disabled={busy || note.trim().length < 4} onClick={() => act("reverse", "Marked reversed")}>
          Reversed by bank
        </Button>
      ) : null}
      {status === "PENDING" || status === "ELIGIBLE" ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("cancel", "Cancelled")}>
          Cancel
        </Button>
      ) : null}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}

/** Set the default, a shop-type, or a single shop's commission %. */
export function CommissionRateForm({
  shopTypes,
  shops,
}: {
  shopTypes: { key: string; label: string }[];
  shops: { id: string; name: string }[];
}) {
  const { busy, error, notice, send } = useAction();
  const [scope, setScope] = useState<"DEFAULT" | "SHOP_TYPE" | "SHOP">("DEFAULT");
  const [target, setTarget] = useState("");
  const [percent, setPercent] = useState("");

  async function submit() {
    const rateBp = Math.round(Number(percent) * 100);
    if (!Number.isFinite(rateBp)) return;
    const ok = await send(
      "/api/finance/commission-rates",
      "POST",
      {
        scope,
        shopType: scope === "SHOP_TYPE" ? target : null,
        shopId: scope === "SHOP" ? target : null,
        rateBp,
      },
      "Commission rate saved — applies to orders delivered from now on.",
    );
    if (ok) setPercent("");
  }

  return (
    <div className="grid gap-3 sm:grid-cols-4">
      <Field label="Applies to">
        <select
          className={inputClass}
          value={scope}
          onChange={(e) => {
            setScope(e.target.value as typeof scope);
            setTarget("");
          }}
        >
          <option value="DEFAULT">Platform default</option>
          <option value="SHOP_TYPE">A shop type</option>
          <option value="SHOP">One shop</option>
        </select>
      </Field>
      {scope !== "DEFAULT" ? (
        <Field label={scope === "SHOP_TYPE" ? "Shop type" : "Shop"}>
          <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {(scope === "SHOP_TYPE"
              ? shopTypes.map((t) => ({ value: t.key, label: t.label }))
              : shops.map((s) => ({ value: s.id, label: s.name }))
            ).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label="Commission %">
        <input
          className={inputClass}
          type="number"
          min={0}
          max={50}
          step={0.01}
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
      </Field>
      <div className="flex items-end">
        <Button disabled={busy || percent === "" || (scope !== "DEFAULT" && !target)} onClick={submit}>
          Save rate
        </Button>
      </div>
      <div className="sm:col-span-4">
        <Messages error={error} notice={notice} />
      </div>
    </div>
  );
}

/** Refund a delivered order to the customer's wallet (full, partial or item amount). */
export function RefundDeliveredForm() {
  const { busy, error, notice, send } = useAction();
  const [orderNumber, setOrderNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [chargeTo, setChargeTo] = useState<"SHOP" | "PLATFORM">("SHOP");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  async function submit() {
    const ok = await send(
      "/api/finance/refunds",
      "POST",
      { orderNumber: orderNumber.trim(), amountPaise: rupeesToPaise(Number(amount)), reason, chargeTo, requestId },
      "Refunded to the customer's wallet.",
    );
    if (ok) {
      setOrderNumber("");
      setAmount("");
      setReason("");
      setRequestId(crypto.randomUUID());
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-5">
      <Field label="Order number">
        <input className={inputClass} value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} />
      </Field>
      <Field label="Amount (₹)">
        <input className={inputClass} type="number" min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Charge to">
        <select className={inputClass} value={chargeTo} onChange={(e) => setChargeTo(e.target.value as "SHOP" | "PLATFORM")}>
          <option value="SHOP">Shop (its share, next settlement)</option>
          <option value="PLATFORM">Platform</option>
        </select>
      </Field>
      <Field label="Reason">
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="flex items-end">
        <Button
          variant="danger"
          disabled={busy || !orderNumber.trim() || !(Number(amount) > 0) || reason.trim().length < 3}
          onClick={submit}
        >
          Refund
        </Button>
      </div>
      <div className="sm:col-span-5">
        <Messages error={error} notice={notice} />
      </div>
    </div>
  );
}

/** Shop, rider, delivery or marketplace adjustment (Part G). */
export function AdjustmentForm({
  shops,
  riders,
}: {
  shops: { id: string; name: string }[];
  riders: { id: string; name: string }[];
}) {
  const { busy, error, notice, send } = useAction();
  const [type, setType] = useState<"SHOP_ADJUSTMENT" | "RIDER_ADJUSTMENT" | "DELIVERY_ADJUSTMENT" | "MARKETPLACE_ADJUSTMENT">(
    "SHOP_ADJUSTMENT",
  );
  const [target, setTarget] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const forShop = type === "SHOP_ADJUSTMENT";
  const forRider = type === "RIDER_ADJUSTMENT" || type === "DELIVERY_ADJUSTMENT";

  async function submit() {
    const ok = await send(
      "/api/finance/adjustments",
      "POST",
      {
        type,
        shopId: forShop ? target : null,
        deliveryPartnerId: forRider ? target : null,
        orderNumber: orderNumber.trim() || null,
        amountPaise: rupeesToPaise(Number(amount)),
        reason,
        requestId,
      },
      "Adjustment recorded — it goes into the next batch.",
    );
    if (ok) {
      setAmount("");
      setReason("");
      setOrderNumber("");
      setRequestId(crypto.randomUUID());
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Type">
        <select
          className={inputClass}
          value={type}
          onChange={(e) => {
            setType(e.target.value as typeof type);
            setTarget("");
          }}
        >
          <option value="SHOP_ADJUSTMENT">Shop adjustment</option>
          <option value="RIDER_ADJUSTMENT">Rider adjustment</option>
          <option value="DELIVERY_ADJUSTMENT">Delivery-related (rider)</option>
          <option value="MARKETPLACE_ADJUSTMENT">Marketplace (platform only)</option>
        </select>
      </Field>
      {forShop || forRider ? (
        <Field label={forShop ? "Shop" : "Delivery partner"}>
          <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {(forShop ? shops : riders).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <div />
      )}
      <Field label="Order number (optional)">
        <input className={inputClass} value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} />
      </Field>
      <Field label="Amount ₹ (− to recover)" hint="+ is owed to the shop/rider">
        <input className={inputClass} type="number" step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Reason">
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="flex items-end">
        <Button
          disabled={busy || !Number(amount) || reason.trim().length < 3 || ((forShop || forRider) && !target)}
          onClick={submit}
        >
          Record adjustment
        </Button>
      </div>
      <div className="sm:col-span-3">
        <Messages error={error} notice={notice} />
      </div>
    </div>
  );
}

/** Run reconciliation for the selected period and store the results. */
export function RunReconciliationButton({ from, to }: { from: string; to: string }) {
  const { busy, error, notice, send } = useAction();
  return (
    <div>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => send("/api/finance/reconciliation", "POST", { from, to }, "Reconciliation run.")}>
        Run reconciliation for this period
      </Button>
      <Messages error={error} notice={notice} />
    </div>
  );
}

/** Close one reconciliation record after investigating it. */
export function ResolveRecordButton({ id }: { id: string }) {
  const { busy, error, send } = useAction();
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Resolve
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input
        className="w-56 rounded-lg border border-cream-200 px-2 py-1 text-xs"
        placeholder="What was found and done"
        aria-label="Resolution note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button size="sm" disabled={busy || note.trim().length < 5} onClick={() => send(`/api/finance/reconciliation/${id}`, "PATCH", { note }, "Resolved")}>
        Mark reconciled
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
