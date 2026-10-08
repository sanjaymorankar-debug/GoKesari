"use client";

/** Module 2: admin editor for dated GST rules and fallback HSN rates. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

interface Rule {
  id: string;
  key: string;
  value: unknown;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
}

interface Rate {
  id: string;
  hsnPrefix: string;
  rateBp: number;
  cessBp: number;
  description: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export function GstConfigEditor({ rules, help, rates, today }: { rules: Rule[]; help: Record<string, string>; rates: Rate[]; today: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; value: string; from: string; note: string } | null>(null);
  const [rate, setRate] = useState({ hsnPrefix: "", ratePercent: "", cessPercent: "0", description: "", effectiveFrom: today });
  const keys = Object.keys(help);

  async function send(url: string, method: string, body: unknown, done: string) {
    setError(null);
    setNotice(null);
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? "Could not save.");
      return false;
    }
    setNotice(done);
    router.refresh();
    return true;
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {keys.map((key) => {
        const rows = rules.filter((r) => r.key === key);
        const current = rows.find((r) => r.effectiveFrom <= today && (!r.effectiveTo || r.effectiveTo >= today));
        return (
          <Card key={key} className="space-y-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold text-ink-900">{key}</h2>
              <Button size="sm" variant="secondary" onClick={() => setEditing({ key, value: JSON.stringify(current?.value ?? {}, null, 2), from: today, note: "" })}>Change from a date</Button>
            </div>
            <p className="text-xs text-ink-500">{help[key]}</p>
            <ul className="space-y-1 text-xs">
              {rows.map((r) => (
                <li key={r.id} className={r === current ? "font-semibold" : "text-ink-500"}>
                  {r.effectiveFrom} → {r.effectiveTo ?? "…"}: <code>{JSON.stringify(r.value)}</code>
                  {r.note ? <span className="block font-normal text-ink-500">{r.note}</span> : null}
                </li>
              ))}
            </ul>
            {editing?.key === key ? (
              <form
                className="space-y-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  let value: unknown;
                  try {
                    value = JSON.parse(editing.value);
                  } catch {
                    setError("The value is not valid JSON.");
                    return;
                  }
                  if (await send("/api/admin/gst-config", "PUT", { key, value, effectiveFrom: editing.from, note: editing.note || undefined }, `${key} saved.`)) setEditing(null);
                }}
              >
                <Field label="Value (JSON)">
                  <textarea className={`${inputClass} font-mono`} rows={5} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
                </Field>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="In force from"><input type="date" className={inputClass} min={today} value={editing.from} onChange={(e) => setEditing({ ...editing, from: e.target.value })} /></Field>
                  <Field label="Note (source, e.g. notification no.)"><input className={inputClass} value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm">Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              </form>
            ) : null}
          </Card>
        );
      })}

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold text-ink-900">Fallback GST rate by HSN</h2>
        <p className="text-xs text-ink-500">Used only when a product has no GST rate of its own. Fill as your CA advises; the longest matching HSN prefix wins.</p>
        <form
          className="grid gap-2 sm:grid-cols-5"
          onSubmit={async (e) => {
            e.preventDefault();
            await send(
              "/api/admin/hsn-tax-rates",
              "PUT",
              { hsnPrefix: rate.hsnPrefix, ratePercent: Number(rate.ratePercent), cessPercent: Number(rate.cessPercent || 0), description: rate.description || undefined, effectiveFrom: rate.effectiveFrom },
              `HSN ${rate.hsnPrefix} saved.`,
            );
          }}
        >
          <input className={inputClass} placeholder="HSN (e.g. 0401)" value={rate.hsnPrefix} onChange={(e) => setRate({ ...rate, hsnPrefix: e.target.value })} required />
          <input className={inputClass} placeholder="GST %" type="number" step="0.01" value={rate.ratePercent} onChange={(e) => setRate({ ...rate, ratePercent: e.target.value })} required />
          <input className={inputClass} placeholder="Cess %" type="number" step="0.01" value={rate.cessPercent} onChange={(e) => setRate({ ...rate, cessPercent: e.target.value })} />
          <input className={inputClass} placeholder="Description" value={rate.description} onChange={(e) => setRate({ ...rate, description: e.target.value })} />
          <div className="flex gap-2">
            <input type="date" className={inputClass} value={rate.effectiveFrom} onChange={(e) => setRate({ ...rate, effectiveFrom: e.target.value })} />
            <Button type="submit" size="sm">Add</Button>
          </div>
        </form>
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs text-ink-500"><tr><th>HSN</th><th>GST</th><th>Cess</th><th>From → to</th><th /></tr></thead>
          <tbody className="divide-y divide-cream-200">
            {rates.map((r) => (
              <tr key={r.id}>
                <td>{r.hsnPrefix}<span className="block text-xs text-ink-500">{r.description}</span></td>
                <td>{r.rateBp / 100}%</td>
                <td>{r.cessBp / 100}%</td>
                <td className="text-xs">{r.effectiveFrom} → {r.effectiveTo ?? "…"}</td>
                <td>
                  {!r.effectiveTo ? (
                    <Button size="sm" variant="ghost" onClick={() => {
                      const to = window.prompt("Last day this rate applies (YYYY-MM-DD)", today);
                      if (to) void send(`/api/admin/hsn-tax-rates/${r.id}`, "PATCH", { effectiveTo: to }, "Rate ended.");
                    }}>End</Button>
                  ) : null}
                </td>
              </tr>
            ))}
            {rates.length === 0 ? <tr><td colSpan={5} className="py-3 text-ink-500">None yet.</td></tr> : null}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
