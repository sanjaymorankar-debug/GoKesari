"use client";

/**
 * Admin → Shops → Unpaid & expiring registrations (0210; docs/shop-registration-subscription-2026-11).
 * One row per shop with the brief's columns; tick rows for bulk Send reminder / Create payment link;
 * each row also has Expiry (reason required), Mark as paid (reference + note) and History (audit trail).
 */
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";

export interface RegistrationTableRow {
  shopId: string;
  shopName: string;
  registrationNumber: string;
  ownerName: string;
  phone: string;
  email: string | null;
  shopTypeLabel: string;
  dealerCode: string | null;
  area: string;
  city: string;
  registeredOn: string;
  expiryOn: string;
  expiryIso: string | null;
  daysLeft: number | null;
  status: "UNPAID" | "ACTIVE" | "EXPIRING_SOON" | "GRACE" | "EXPIRED" | "EXEMPT";
  amountDue: string;
  amountDuePaise: number;
  dueKind: "REGISTRATION" | "RENEWAL";
  lastReminder: string;
  link: { status: string; amount: string; until: string; url: string | null } | null;
  remindersEnabled: boolean;
}

const STATUS_LABEL: Record<RegistrationTableRow["status"], string> = {
  UNPAID: "Unpaid",
  ACTIVE: "Active",
  EXPIRING_SOON: "Expiring soon",
  GRACE: "Grace",
  EXPIRED: "Expired",
  EXEMPT: "Exempt",
};
const STATUS_TONE: Record<RegistrationTableRow["status"], "success" | "warning" | "danger" | "info" | "neutral"> = {
  UNPAID: "danger",
  ACTIVE: "success",
  EXPIRING_SOON: "warning",
  GRACE: "danger",
  EXPIRED: "danger",
  EXEMPT: "info",
};

type Dialog =
  | { kind: "LINK"; shopIds: string[]; single: RegistrationTableRow | null }
  | { kind: "EXPIRY"; row: RegistrationTableRow }
  | { kind: "PAID"; row: RegistrationTableRow }
  | { kind: "HISTORY"; row: RegistrationTableRow }
  | null;

interface AuditEntry {
  id: string;
  action: string;
  atIst: string;
  actor: string;
  actorRole: string | null;
  previousValue: unknown;
  newValue: unknown;
}

async function post(body: unknown): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const res = await fetch("/api/admin/registration-subscription", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
  return res.ok ? { ok: true, data: json } : { ok: false, error: json.error?.message ?? `Failed (${res.status})` };
}

function rupeesToPaise(v: string): number | null {
  const n = Number(v.replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

export function ShopRegistrationsTable({ rows, linkValidityDays }: { rows: RegistrationTableRow[]; linkValidityDays: number }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.shopId));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function run(body: unknown, done: (data: Record<string, unknown>) => string) {
    setBusy(true);
    setMessage(null);
    const r = await post(body);
    setBusy(false);
    if (!r.ok) {
      setMessage({ tone: "danger", text: r.error ?? "Failed" });
      return false;
    }
    setMessage({ tone: "success", text: done(r.data ?? {}) });
    setDialog(null);
    router.refresh();
    return true;
  }

  const remind = (ids: string[]) =>
    run({ action: "REMIND", shopIds: ids }, (d) => {
      const skipped = (d.skipped as { reason: string }[] | undefined) ?? [];
      return `Reminder sent to ${d.sent ?? 0} shop(s) by in-app alert, push and e-mail.${skipped.length ? ` Skipped ${skipped.length}: ${[...new Set(skipped.map((s) => s.reason))].join(", ")}.` : ""}`;
    });

  return (
    <div>
      {message ? (
        <div className="mb-3" role="status">
          <Alert tone={message.tone}>{message.text}</Alert>
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Bulk actions">
        <span className="text-sm text-ink-700">{selected.size} selected</span>
        <Button size="sm" disabled={busy || selected.size === 0} onClick={() => remind([...selected])}>
          Send reminder
        </Button>
        <Button size="sm" variant="secondary" disabled={busy || selected.size === 0} onClick={() => setDialog({ kind: "LINK", shopIds: [...selected], single: null })}>
          Create payment link
        </Button>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-left text-sm" data-testid="shop-registrations">
          <thead className="bg-cream-100 text-xs uppercase text-ink-500">
            <tr>
              <th className="px-2 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all shops"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.shopId)))}
                  className="h-5 w-5"
                />
              </th>
              <th className="px-2 py-2">Shop</th>
              <th className="px-2 py-2">Owner</th>
              <th className="px-2 py-2">Type · dealer</th>
              <th className="px-2 py-2">Registered</th>
              <th className="px-2 py-2">Expiry</th>
              <th className="px-2 py-2">Days left</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Amount due</th>
              <th className="px-2 py-2">Last reminder</th>
              <th className="px-2 py-2">Payment link</th>
              <th className="px-2 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {rows.map((r) => (
              <tr key={r.shopId} data-shop-id={r.shopId}>
                <td className="px-2 py-2 align-top">
                  <input type="checkbox" aria-label={`Select ${r.shopName}`} checked={selected.has(r.shopId)} onChange={() => toggle(r.shopId)} className="h-5 w-5" />
                </td>
                <td className="px-2 py-2 align-top">
                  <a href={`/admin/shops/${r.shopId}`} className="font-medium text-ink-900 hover:underline">
                    {r.shopName}
                  </a>
                  <span className="block text-xs text-ink-500">
                    {r.registrationNumber} · {[r.area, r.city].filter(Boolean).join(", ")}
                  </span>
                </td>
                <td className="px-2 py-2 align-top">
                  {r.ownerName}
                  <span className="block text-xs text-ink-500">{r.phone}</span>
                  {r.email ? <span className="block text-xs text-ink-500">{r.email}</span> : null}
                </td>
                <td className="px-2 py-2 align-top">
                  {r.shopTypeLabel}
                  <span className="block text-xs text-ink-500">{r.dealerCode ?? "no dealer code"}</span>
                </td>
                <td className="px-2 py-2 align-top whitespace-nowrap">{r.registeredOn}</td>
                <td className="px-2 py-2 align-top whitespace-nowrap">{r.expiryOn}</td>
                <td className="px-2 py-2 align-top">{r.daysLeft ?? "—"}</td>
                <td className="px-2 py-2 align-top">
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  {!r.remindersEnabled ? <span className="block text-xs text-ink-500">reminders off</span> : null}
                </td>
                <td className="px-2 py-2 align-top whitespace-nowrap">
                  {r.amountDuePaise > 0 ? r.amountDue : "—"}
                  <span className="block text-xs text-ink-500">{r.amountDuePaise > 0 ? (r.dueKind === "REGISTRATION" ? "registration" : "renewal") : ""}</span>
                </td>
                <td className="px-2 py-2 align-top text-xs">{r.lastReminder}</td>
                <td className="px-2 py-2 align-top text-xs">
                  {r.link ? (
                    <>
                      <span className="font-semibold">{r.link.status.toLowerCase()}</span> · {r.link.amount}
                      <span className="block">until {r.link.until}</span>
                      {r.link.url && r.link.status === "ACTIVE" ? (
                        <a href={r.link.url} target="_blank" rel="noreferrer" className="text-kesari-800 underline">
                          open
                        </a>
                      ) : null}
                    </>
                  ) : (
                    "none"
                  )}
                </td>
                <td className="px-2 py-2 align-top">
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="secondary" disabled={busy || r.status === "EXEMPT"} onClick={() => remind([r.shopId])}>
                      Remind
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy || r.status === "EXEMPT"} onClick={() => setDialog({ kind: "LINK", shopIds: [r.shopId], single: r })}>
                      Link
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDialog({ kind: "EXPIRY", row: r })}>
                      Expiry
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy || r.status === "EXEMPT"} onClick={() => setDialog({ kind: "PAID", row: r })}>
                      Mark paid
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "HISTORY", row: r })}>
                      History
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {dialog?.kind === "LINK" ? <LinkDialog dialog={dialog} validityDays={linkValidityDays} busy={busy} onClose={() => setDialog(null)} onSubmit={(body) => run(body, linkDone)} /> : null}
      {dialog?.kind === "EXPIRY" ? <ExpiryDialog row={dialog.row} busy={busy} onClose={() => setDialog(null)} onSubmit={(body) => run(body, () => `Expiry of ${dialog.row.shopName} changed; the owner was told.`)} /> : null}
      {dialog?.kind === "PAID" ? <PaidDialog row={dialog.row} busy={busy} onClose={() => setDialog(null)} onSubmit={(body) => run(body, (d) => `Recorded as paid (receipt ${String(d.reference ?? "")}). ${d.extendedTo ? "Registration extended." : "Not extended yet: the amount does not cover the fee."}`)} /> : null}
      {dialog?.kind === "HISTORY" ? <HistoryDialog row={dialog.row} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function linkDone(d: Record<string, unknown>): string {
  const created = (d.created as unknown[] | undefined)?.length ?? 0;
  const failed = (d.failed as { reason: string }[] | undefined) ?? [];
  return `${created} payment link(s) created and sent to the owner by in-app alert, push and e-mail; older links cancelled.${failed.length ? ` ${failed.length} failed: ${failed.map((f) => f.reason).join("; ")}` : ""}`;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
          <button type="button" onClick={onClose} className="min-h-11 px-3 text-sm text-ink-700 underline">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function LinkDialog({ dialog, validityDays, busy, onClose, onSubmit }: { dialog: Extract<Dialog, { kind: "LINK" }>; validityDays: number; busy: boolean; onClose: () => void; onSubmit: (body: unknown) => void }) {
  const single = dialog.single;
  const [amount, setAmount] = useState(single && single.amountDuePaise > 0 ? (single.amountDuePaise / 100).toFixed(2) : "");
  const [days, setDays] = useState(String(validityDays));
  const [reason, setReason] = useState("");
  return (
    <Modal title={single ? `New payment link — ${single.shopName}` : `New payment links — ${dialog.shopIds.length} shops`} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-700">
        A new link replaces (cancels) any older active link for the shop and is sent to the owner by in-app alert, push and e-mail. Unpaid shops pay the registration fee; others the renewal fee.
      </p>
      {single ? (
        <label className="mb-3 block text-sm font-medium text-ink-800">
          Amount (₹) — editable
          <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
      ) : (
        <p className="mb-3 text-sm text-ink-700">Each shop gets its own amount due.</p>
      )}
      <label className="mb-3 block text-sm font-medium text-ink-800">
        Link valid for (days)
        <input className={inputClass} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
      </label>
      <label className="mb-3 block text-sm font-medium text-ink-800">
        Note (optional)
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <Button
        disabled={busy}
        onClick={() =>
          onSubmit({
            action: "LINK",
            shopIds: dialog.shopIds,
            amountPaise: single ? rupeesToPaise(amount) : null,
            validityDays: Math.min(30, Math.max(1, Number(days) || validityDays)),
            reason: reason || null,
          })
        }
      >
        Create and send link
      </Button>
    </Modal>
  );
}

function ExpiryDialog({ row, busy, onClose, onSubmit }: { row: RegistrationTableRow; busy: boolean; onClose: () => void; onSubmit: (body: unknown) => void }) {
  const [mode, setMode] = useState<"EXTEND" | "SHORTEN" | "SET_DATE" | "EXPIRE_NOW">("EXTEND");
  const [days, setDays] = useState("30");
  const [date, setDate] = useState(row.expiryIso ? row.expiryIso.slice(0, 10) : "");
  const [reason, setReason] = useState("");
  const change = mode === "EXTEND" || mode === "SHORTEN" ? { mode, days: Number(days) } : mode === "SET_DATE" ? { mode, date } : { mode };
  return (
    <Modal title={`Registration expiry — ${row.shopName}`} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-700">Current expiry: {row.expiryOn}. The change, who made it and the reason are recorded; the owner is told.</p>
      <fieldset className="mb-3">
        <legend className="mb-1 text-sm font-medium text-ink-800">Change</legend>
        {(
          [
            ["EXTEND", "Extend by days"],
            ["SHORTEN", "Shorten by days"],
            ["SET_DATE", "Set a date"],
            ["EXPIRE_NOW", "Expire now (no grace)"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex min-h-11 items-center gap-2 text-sm">
            <input type="radio" name="mode" checked={mode === key} onChange={() => setMode(key)} className="h-5 w-5" />
            {label}
          </label>
        ))}
      </fieldset>
      {mode === "EXTEND" || mode === "SHORTEN" ? (
        <label className="mb-3 block text-sm font-medium text-ink-800">
          Days
          <input className={inputClass} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
      ) : null}
      {mode === "SET_DATE" ? (
        <label className="mb-3 block text-sm font-medium text-ink-800">
          New expiry date (IST)
          <input type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      ) : null}
      <label className="mb-3 block text-sm font-medium text-ink-800">
        Reason (required)
        <textarea className={inputClass} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <Button variant={mode === "EXPIRE_NOW" ? "danger" : "primary"} disabled={busy || reason.trim().length < 5} onClick={() => onSubmit({ action: "EXPIRY", shopId: row.shopId, change, reason })}>
        Save expiry
      </Button>
    </Modal>
  );
}

function PaidDialog({ row, busy, onClose, onSubmit }: { row: RegistrationTableRow; busy: boolean; onClose: () => void; onSubmit: (body: unknown) => void }) {
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [method, setMethod] = useState<"CASH" | "UPI" | "BANK_TRANSFER" | "CHEQUE" | "OTHER">("CASH");
  const [amount, setAmount] = useState(row.amountDuePaise > 0 ? (row.amountDuePaise / 100).toFixed(2) : "");
  const [paidOn, setPaidOn] = useState("");
  return (
    <Modal title={`Mark as paid — ${row.shopName}`} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-700">
        {row.dueKind === "REGISTRATION" ? "Registration fee" : "Renewal fee"} received outside the payment gateway. It is written to the shop&apos;s payment ledger and extends the registration by 1 year.
      </p>
      <label className="mb-3 block text-sm font-medium text-ink-800">
        Reference number (required)
        <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} />
      </label>
      <label className="mb-3 block text-sm font-medium text-ink-800">
        Method
        <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          <option value="CASH">Cash</option>
          <option value="UPI">UPI</option>
          <option value="BANK_TRANSFER">Bank transfer</option>
          <option value="CHEQUE">Cheque</option>
          <option value="OTHER">Other</option>
        </select>
      </label>
      <label className="mb-3 block text-sm font-medium text-ink-800">
        Amount received (₹)
        <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="mb-3 block text-sm font-medium text-ink-800">
        Received on (IST, optional)
        <input type="date" className={inputClass} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      </label>
      <label className="mb-3 block text-sm font-medium text-ink-800">
        Note (required)
        <textarea className={inputClass} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <Button
        disabled={busy || reference.trim().length < 3 || note.trim().length < 3}
        onClick={() => onSubmit({ action: "MARK_PAID", shopId: row.shopId, reference, note, method, amountPaise: rupeesToPaise(amount), paidOn: paidOn || null })}
      >
        Record payment
      </Button>
    </Modal>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "shop.registration_reminder_sent": "Reminder sent",
  "shop.registration_link_created": "Payment link created",
  "shop.registration_link_cancelled": "Payment link cancelled",
  "shop.registration_expiry_changed": "Expiry changed",
  "shop.registration_marked_paid": "Marked as paid",
  "shop.registration_settings_changed": "Shop settings changed",
  "shop.membership_period_opened": "Registration year added",
  "shop.membership_renewal_paid": "Renewal paid online",
  "shop.membership_exemption_changed": "Exemption changed",
};

function HistoryDialog({ row, onClose }: { row: RegistrationTableRow; onClose: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/admin/registration-subscription/${row.shopId}`)
      .then(async (res) => {
        const json = (await res.json()) as { audit?: AuditEntry[]; error?: { message?: string } };
        if (!res.ok) throw new Error(json.error?.message ?? `Failed (${res.status})`);
        if (live) setEntries(json.audit ?? []);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [row.shopId]);
  const show = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <Modal title={`Registration history — ${row.shopName}`} onClose={onClose}>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!entries && !error ? <p className="text-sm text-ink-700">Loading…</p> : null}
      {entries && entries.length === 0 ? <p className="text-sm text-ink-700">Nothing recorded yet.</p> : null}
      <ol className="space-y-3">
        {(entries ?? []).map((e) => (
          <li key={e.id} className="rounded border border-cream-200 p-2 text-xs">
            <p className="text-sm font-semibold text-ink-900">{ACTION_LABEL[e.action] ?? e.action}</p>
            <p className="text-ink-600">
              {e.atIst} · {e.actor}
              {e.actorRole ? ` (${e.actorRole})` : ""}
            </p>
            <p className="mt-1 break-words text-ink-700">Old: {show(e.previousValue)}</p>
            <p className="break-words text-ink-700">New: {show(e.newValue)}</p>
          </li>
        ))}
      </ol>
    </Modal>
  );
}
