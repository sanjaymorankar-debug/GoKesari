"use client";

/**
 * Billing v2 (docs/billing §6.1, §6.2): journal, contra and stock journal
 * forms. The server checks the balance and posts the voucher.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

type Option = { value: string; label: string };

async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message ?? "Not saved.");
}

function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: "success", text: done });
      router.refresh();
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Not saved." });
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, run };
}

const paise = (rupees: string) => Math.round(Number(rupees || 0) * 100);

export function JournalForms({ shopId, accounts, items }: { shopId: string; accounts: Option[]; items: Option[] }) {
  const base = `/api/shops/${shopId}/accounts/journals`;
  const j = useSubmit();
  const c = useSubmit();
  const s = useSubmit();
  const [narration, setNarration] = useState("");
  const [legs, setLegs] = useState([
    { account: accounts[0]?.value ?? "", debit: "", credit: "" },
    { account: accounts[1]?.value ?? "", debit: "", credit: "" },
  ]);
  const [contra, setContra] = useState({ from: "CASH", amount: "" });
  const [stock, setStock] = useState({ shopProductId: items[0]?.value ?? "", from: "ONLINE", qty: "" });
  const dr = legs.reduce((n, l) => n + paise(l.debit), 0);
  const cr = legs.reduce((n, l) => n + paise(l.credit), 0);

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Card className="p-3">
        <h2 className="mb-2 font-bold text-ink-900">Journal</h2>
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void j.run(
              () => post(base, { narration, legs: legs.map((l) => ({ account: l.account, debitPaise: paise(l.debit) || undefined, creditPaise: paise(l.credit) || undefined })) }),
              "Journal posted.",
            );
          }}
        >
          {legs.map((l, i) => (
            <div key={i} className="grid grid-cols-3 gap-1">
              <select aria-label={`Ledger ${i + 1}`} className={`${inputClass} col-span-3`} value={l.account} onChange={(e) => setLegs((ls) => ls.map((x, k) => (k === i ? { ...x, account: e.target.value } : x)))}>
                {accounts.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
              <input aria-label={`Debit ${i + 1}`} placeholder="Dr ₹" inputMode="decimal" className={inputClass} value={l.debit} onChange={(e) => setLegs((ls) => ls.map((x, k) => (k === i ? { ...x, debit: e.target.value } : x)))} />
              <input aria-label={`Credit ${i + 1}`} placeholder="Cr ₹" inputMode="decimal" className={inputClass} value={l.credit} onChange={(e) => setLegs((ls) => ls.map((x, k) => (k === i ? { ...x, credit: e.target.value } : x)))} />
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={() => setLegs((ls) => [...ls, { account: accounts[0]?.value ?? "", debit: "", credit: "" }])}>
            + Line
          </Button>
          <Field label="Narration">
            <input className={inputClass} value={narration} onChange={(e) => setNarration(e.target.value)} required minLength={3} />
          </Field>
          <p className={`text-xs ${dr === cr && dr > 0 ? "text-green-800" : "text-red-700"}`}>
            Dr ₹{(dr / 100).toFixed(2)} · Cr ₹{(cr / 100).toFixed(2)}
          </p>
          <Button type="submit" disabled={j.busy || dr !== cr || dr === 0}>
            Post journal
          </Button>
          {j.message ? <Alert tone={j.message.tone}>{j.message.text}</Alert> : null}
        </form>
      </Card>
      <Card className="p-3">
        <h2 className="mb-2 font-bold text-ink-900">Contra (cash ↔ bank)</h2>
        <form className="grid gap-2" onSubmit={(e) => (e.preventDefault(), void c.run(() => post(`${base}/contra`, { from: contra.from, amountPaise: paise(contra.amount) }), "Contra posted."))}>
          <Field label="Direction">
            <select className={inputClass} value={contra.from} onChange={(e) => setContra({ ...contra, from: e.target.value })}>
              <option value="CASH">Cash deposited in the bank</option>
              <option value="BANK">Cash drawn from the bank</option>
            </select>
          </Field>
          <Field label="Amount (₹)">
            <input className={inputClass} inputMode="decimal" value={contra.amount} onChange={(e) => setContra({ ...contra, amount: e.target.value })} required />
          </Field>
          <Button type="submit" disabled={c.busy || paise(contra.amount) <= 0}>
            Post contra
          </Button>
          {c.message ? <Alert tone={c.message.tone}>{c.message.text}</Alert> : null}
        </form>
      </Card>
      <Card className="p-3">
        <h2 className="mb-2 font-bold text-ink-900">Stock journal (move stock)</h2>
        <form className="grid gap-2" onSubmit={(e) => (e.preventDefault(), void s.run(() => post(`${base}/stock`, { shopProductId: stock.shopProductId, from: stock.from, qtyMilli: Math.round(Number(stock.qty) * 1000) }), "Stock moved."))}>
          <Field label="Item">
            <select className={inputClass} value={stock.shopProductId} onChange={(e) => setStock({ ...stock, shopProductId: e.target.value })}>
              {items.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <select className={inputClass} value={stock.from} onChange={(e) => setStock({ ...stock, from: e.target.value })}>
              <option value="ONLINE">Online count → in-shop</option>
              <option value="OFFLINE">In-shop → online count</option>
            </select>
          </Field>
          <Field label="Quantity">
            <input className={inputClass} inputMode="decimal" value={stock.qty} onChange={(e) => setStock({ ...stock, qty: e.target.value })} required />
          </Field>
          <Button type="submit" disabled={s.busy || !(Number(stock.qty) > 0)}>
            Move stock
          </Button>
          {s.message ? <Alert tone={s.message.tone}>{s.message.text}</Alert> : null}
        </form>
      </Card>
    </div>
  );
}
