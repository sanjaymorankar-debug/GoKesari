"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

interface Area {
  code: string;
  name: string;
  shortCode: string | null;
}

const TYPES = [
  ["INDIVIDUAL", "Individual"],
  ["PROPRIETORSHIP", "Proprietorship"],
  ["PARTNERSHIP", "Partnership"],
  ["COMPANY", "Company"],
] as const;
const NEW = "__new__";

/**
 * Admin → Dealers → Add dealer (docs/dealer-programme, all-India): any state or
 * union territory, one of its districts or a new one, and the dealer is
 * approved at once with a generated code (GKS-<state>-<district>-…).
 */
export function AddDealerForm({ states }: { states: { code: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ legalName: "", contactName: "", dealerType: "PROPRIETORSHIP", stateCode: "", districtCode: "", newDistrictName: "", email: "", mobile: "", city: "", pincode: "", reason: "" });
  const [districts, setDistricts] = useState<{ state: string; areas: Area[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; code: string } | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (!form.stateCode) return;
    const ctrl = new AbortController();
    fetch(`/api/geo-areas?state=${form.stateCode}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((p) => setDistricts({ state: form.stateCode, areas: p?.areas ?? [] }))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [form.stateCode]);
  const list = districts?.state === form.stateCode ? districts.areas : [];

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/dealers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          districtCode: form.districtCode && form.districtCode !== NEW ? form.districtCode : null,
          newDistrictName: form.districtCode === NEW ? form.newDistrictName : null,
          email: form.email || null,
          mobile: form.mobile || null,
          city: form.city || null,
          pincode: form.pincode || null,
        }),
      });
      const p = await res.json().catch(() => null);
      if (!res.ok) throw new Error(p?.error?.message ?? "That did not work.");
      setCreated({ name: p.dealer.legalName, code: p.code });
      setForm((f) => ({ ...f, legalName: "", contactName: "", email: "", mobile: "", city: "", pincode: "", reason: "", newDistrictName: "" }));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mb-4">
        <Button size="sm" onClick={() => setOpen(true)}>
          Add dealer
        </Button>
      </div>
    );
  }
  return (
    <Card className="mb-4 space-y-3 p-4" data-testid="add-dealer">
      <h2 className="text-base font-bold text-ink-900">Add a dealer</h2>
      <p className="text-sm text-ink-600">Any state or union territory. The dealer is approved at once and gets a unique code. Documents and bank details can follow on the dealer&apos;s page.</p>
      {error ? <Alert tone="danger" title="Could not add the dealer">{error}</Alert> : null}
      {created ? (
        <Alert tone="success" title="Dealer added">
          {created.name}: code <strong>{created.code}</strong>
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Legal or business name">
          <input className={inputClass} value={form.legalName} onChange={set("legalName")} maxLength={120} aria-label="Legal or business name" />
        </Field>
        <Field label="Owner / contact name">
          <input className={inputClass} value={form.contactName} onChange={set("contactName")} maxLength={120} aria-label="Contact name" />
        </Field>
        <Field label="Type">
          <select className={inputClass} value={form.dealerType} onChange={set("dealerType")} aria-label="Dealer type">
            {TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State / union territory">
          <select className={inputClass} value={form.stateCode} onChange={(e) => setForm((f) => ({ ...f, stateCode: e.target.value, districtCode: "" }))} aria-label="State">
            <option value="">Choose…</option>
            {states.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="District" hint={form.stateCode && list.length === 0 ? "No districts yet for this state — add the first one." : undefined}>
          <select className={inputClass} value={form.districtCode} onChange={set("districtCode")} disabled={!form.stateCode} aria-label="District">
            <option value="">{form.stateCode ? "Whole state (no district)" : "Choose the state first"}</option>
            {list.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name}
              </option>
            ))}
            {form.stateCode ? <option value={NEW}>+ Add a new district…</option> : null}
          </select>
        </Field>
        {form.districtCode === NEW ? (
          <Field label="New district's name" hint="Its short code for dealer codes is generated.">
            <input className={inputClass} value={form.newDistrictName} onChange={set("newDistrictName")} maxLength={80} aria-label="New district name" />
          </Field>
        ) : null}
        <Field label="Sign-in e-mail (optional)" hint="An existing GoKesari account becomes the dealer's sign-in.">
          <input className={inputClass} type="email" value={form.email} onChange={set("email")} maxLength={200} aria-label="E-mail" />
        </Field>
        <Field label="Mobile (optional)">
          <input className={inputClass} inputMode="numeric" value={form.mobile} onChange={set("mobile")} maxLength={14} aria-label="Mobile" />
        </Field>
        <Field label="City (optional)">
          <input className={inputClass} value={form.city} onChange={set("city")} maxLength={80} aria-label="City" />
        </Field>
        <Field label="PIN code (optional)">
          <input className={inputClass} inputMode="numeric" value={form.pincode} onChange={set("pincode")} maxLength={6} aria-label="PIN code" />
        </Field>
      </div>
      <Field label="Reason for adding directly" hint="Kept in the audit log.">
        <input className={inputClass} value={form.reason} onChange={set("reason")} maxLength={300} aria-label="Reason" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !form.legalName.trim() || !form.contactName.trim() || !form.stateCode || form.reason.trim().length < 5 || (form.districtCode === NEW && form.newDistrictName.trim().length < 2)} onClick={submit}>
          {busy ? "Adding…" : "Add dealer and issue code"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </Card>
  );
}
