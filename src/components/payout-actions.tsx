"use client";

/**
 * batch-2026-10 WS-E controls for Admin → Payouts, Platform invoices and
 * Statutory settings. Buttons only call the API; the server decides
 * everything (amounts, permissions, maker-checker).
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";
import { rupeesToPaise } from "@/lib/money";

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
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
  return { busy, error, notice, send, setError, setNotice, setBusy, router };
}

function Messages({ error, notice }: { error: string | null; notice: string | null }) {
  if (error) return <div className="mt-2"><Alert tone="danger">{error}</Alert></div>;
  if (notice) return <p className="mt-2 text-xs text-leaf-700">{notice}</p>;
  return null;
}

export function CloseCycleButton() {
  const { busy, error, notice, send } = useAction();
  return (
    <div>
      <Button size="md" variant="secondary" disabled={busy} onClick={() => send("/api/admin/payouts/cycles", "POST", {}, "Done — the last complete cycle is closed and its batch drafted.")}>
        Close the last cycle now
      </Button>
      <Messages error={error} notice={notice} />
    </div>
  );
}

export function BatchButtons({ batchId, status, provider, canApprove, canManage }: { batchId: string; status: string; provider: string | null; canApprove: boolean; canManage: boolean }) {
  const { busy, error, notice, send, setError, setNotice, setBusy, router } = useAction();
  const [note, setNote] = useState("");
  const url = `/api/admin/payouts/batches/${batchId}`;

  async function downloadFile() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${url}/bank-file`, { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message ?? "The file could not be made.");
      }
      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "payouts.csv";
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      URL.revokeObjectURL(link.href);
      setNotice(`Bank file downloaded (${response.headers.get("X-Payout-Rows") ?? "?"} payments, ${response.headers.get("X-Payout-Skipped") ?? "0"} skipped). Upload it at the bank, then mark each payment paid with its UTR.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file could not be made.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {status === "DRAFT" && canApprove ? (
          <Button size="md" disabled={busy} onClick={() => send(url, "PATCH", { action: "approve" }, "Approved.")}>
            Approve
          </Button>
        ) : null}
        {(status === "APPROVED" || (status === "PROCESSING" && provider !== "BANK_FILE")) && canManage ? (
          <Button size="md" disabled={busy} onClick={() => send(url, "PATCH", { action: "execute" }, "Sent to the payout provider.")}>
            Pay through provider
          </Button>
        ) : null}
        {(status === "APPROVED" || (status === "PROCESSING" && provider === "BANK_FILE")) && canManage ? (
          <Button size="md" variant="secondary" disabled={busy} onClick={downloadFile}>
            Download bank file
          </Button>
        ) : null}
        {(status === "DRAFT" || status === "APPROVED") && canManage ? (
          <>
            <input className={`${inputClass} max-w-56`} placeholder="Reason to cancel" aria-label="Reason to cancel the batch" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button size="md" variant="danger" disabled={busy || note.trim().length < 3} onClick={() => send(url, "PATCH", { action: "cancel", note }, "Cancelled — amounts move to the next cycle.")}>
              Cancel batch
            </Button>
          </>
        ) : null}
      </div>
      <Messages error={error} notice={notice} />
    </div>
  );
}

export function ItemActions({ itemId, status, provider }: { itemId: string; status: string; provider: string | null }) {
  const { busy, error, notice, send } = useAction();
  const [text, setText] = useState("");
  const url = `/api/admin/payouts/items/${itemId}`;
  if (!["PENDING", "PROCESSING", "FAILED"].includes(status)) return null;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputClass} max-w-60`} placeholder="UTR, or the bank's reason" aria-label="UTR or failure reason" value={text} onChange={(e) => setText(e.target.value)} />
        <Button size="sm" disabled={busy || text.trim().length < 6} onClick={() => send(url, "PATCH", { action: "mark_paid", utr: text.trim() }, "Marked paid.")}>
          Mark paid
        </Button>
        {status === "PROCESSING" ? (
          <Button size="sm" variant="secondary" disabled={busy || text.trim().length < 3} onClick={() => send(url, "PATCH", { action: "mark_failed", reason: text.trim() }, "Marked failed.")}>
            Mark failed
          </Button>
        ) : null}
        {status === "FAILED" && provider !== "BANK_FILE" ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => send(url, "PATCH", { action: "retry" }, "Retried.")}>
            Retry now
          </Button>
        ) : null}
        {status === "FAILED" || status === "PENDING" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => send(url, "PATCH", { action: "release" }, "Moved to the next cycle.")}>
            Next cycle
          </Button>
        ) : null}
      </div>
      <Messages error={error} notice={notice} />
    </div>
  );
}

export function PlatformNoteForm({ invoices }: { invoices: { id: string; label: string }[] }) {
  const { busy, error, notice, send } = useAction();
  const [form, setForm] = useState({ invoiceId: invoices[0]?.id ?? "", kind: "CREDIT", feeType: "COMMISSION", amount: "", reason: "" });
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  if (invoices.length === 0) return <p className="text-sm text-ink-500">No invoices yet.</p>;
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await send(
          "/api/admin/platform-invoices/notes",
          "POST",
          { invoiceId: form.invoiceId, kind: form.kind, feeType: form.feeType, taxablePaise: rupeesToPaise(Number(form.amount)), reason: form.reason, requestId },
          "Note issued — it is settled in the shop's next payout.",
        );
        if (ok) setRequestId(crypto.randomUUID());
      }}
    >
      <Field label="Invoice">
        <select className={inputClass} value={form.invoiceId} onChange={(e) => setForm({ ...form, invoiceId: e.target.value })}>
          {invoices.map((i) => (
            <option key={i.id} value={i.id}>{i.label}</option>
          ))}
        </select>
      </Field>
      <Field label="Note">
        <select className={inputClass} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          <option value="CREDIT">Credit note (fee reduced)</option>
          <option value="DEBIT">Debit note (fee under-billed)</option>
        </select>
      </Field>
      <Field label="Fee">
        <select className={inputClass} value={form.feeType} onChange={(e) => setForm({ ...form, feeType: e.target.value })}>
          <option value="COMMISSION">Commission</option>
          <option value="DELIVERY_CHARGE">Delivery charges</option>
          <option value="PLATFORM_FEE">Platform fee</option>
          <option value="REGISTRATION_FEE">Registration fee</option>
          <option value="BILLING_MANAGEMENT">Billing management</option>
        </select>
      </Field>
      <Field label="Taxable amount (₹, before GST)">
        <input className={inputClass} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Reason">
          <input className={inputClass} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={busy || !form.amount || form.reason.trim().length < 3}>
          Issue note
        </Button>
        <Messages error={error} notice={notice} />
      </div>
    </form>
  );
}

export function StatutoryRowActions({ id, enabled, confirmedByCa, rateBp }: { id: string; enabled: boolean; confirmedByCa: boolean; rateBp: number | null }) {
  const { busy, error, notice, send } = useAction();
  const [rate, setRate] = useState(rateBp != null ? String(rateBp / 100) : "");
  const url = `/api/admin/statutory/${id}`;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        {!confirmedByCa ? (
          <Button size="sm" disabled={busy} onClick={() => send(url, "PATCH", { confirmedByCa: true }, "Recorded as confirmed by the CA.")}>
            CA confirmed
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => send(url, "PATCH", { confirmedByCa: false }, "Confirmation withdrawn.")}>
            Withdraw confirmation
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => send(url, "PATCH", { enabled: !enabled }, enabled ? "Disabled." : "Enabled.")}>
          {enabled ? "Disable" : "Enable"}
        </Button>
        {rateBp != null ? (
          <>
            <input className={`${inputClass} w-24`} inputMode="decimal" aria-label="Rate in percent" value={rate} onChange={(e) => setRate(e.target.value)} />
            <span className="text-xs text-ink-500">%</span>
            <Button size="sm" variant="secondary" disabled={busy || rate === "" || Number(rate) * 100 === rateBp} onClick={() => send(url, "PATCH", { rateBp: Math.round(Number(rate) * 100) }, "Rate changed — it needs the CA's confirmation again.")}>
              Save rate
            </Button>
          </>
        ) : null}
      </div>
      <Messages error={error} notice={notice} />
    </div>
  );
}

export function StatutoryAddForm({ keys }: { keys: { key: string; label: string }[] }) {
  const { busy, error, notice, send } = useAction();
  const [form, setForm] = useState({ key: keys[0]?.key ?? "", rate: "", from: "", reference: "", note: "" });
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send(
          "/api/admin/statutory",
          "POST",
          {
            key: form.key,
            label: keys.find((k) => k.key === form.key)?.label ?? form.key,
            enabled: true,
            rateBp: form.rate === "" ? null : Math.round(Number(form.rate) * 100),
            params: {},
            effectiveFrom: form.from,
            legalReference: form.reference || null,
            note: form.note || null,
          },
          "Added — it applies from the chosen day; the previous row ends the day before.",
        );
      }}
    >
      <Field label="Setting">
        <select className={inputClass} value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })}>
          {keys.map((k) => (
            <option key={k.key} value={k.key}>{k.label}</option>
          ))}
        </select>
      </Field>
      <Field label="Rate (%)" hint="Leave empty for settings without a rate.">
        <input className={inputClass} inputMode="decimal" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
      </Field>
      <Field label="Effective from">
        <input className={inputClass} type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
      </Field>
      <Field label="Notification / legal reference">
        <input className={inputClass} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Note">
          <input className={inputClass} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={busy || !form.from}>
          Add dated row
        </Button>
        <Messages error={error} notice={notice} />
      </div>
    </form>
  );
}
