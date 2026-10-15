"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button, Field, inputClass } from "@/components/ui";
import { isValidGstin } from "@/lib/gst-states";
import { accountsApi } from "./api";
import { FormError, parseRupees } from "./payment-forms";

type Kind = "SUPPLIER" | "CUSTOMER" | "BOTH";

export interface PartyFields {
  id: string;
  kind: Kind;
  name: string;
  gstin: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  creditDays: number;
}

interface Draft {
  kind: Kind;
  name: string;
  gstin: string;
  phone: string;
  email: string;
  address: string;
  creditDays: string;
}

function toBody(d: Draft) {
  const gstin = d.gstin.replace(/\s+/g, "").toUpperCase();
  return {
    kind: d.kind,
    name: d.name.trim(),
    gstin: gstin || null,
    phone: d.phone.trim() || null,
    email: d.email.trim() || null,
    address: d.address.trim() || null,
    creditDays: d.creditDays.trim() ? Math.max(0, Math.min(365, Math.round(Number(d.creditDays)))) : 0,
  };
}

function check(d: Draft): string | null {
  if (d.name.trim().length < 2) return "Enter the party's name.";
  const g = d.gstin.replace(/\s+/g, "").toUpperCase();
  if (g && !isValidGstin(g)) return "GSTIN is not valid (15 characters with a matching check digit).";
  if (d.creditDays.trim() && !/^\d{1,3}$/.test(d.creditDays.trim())) return "Credit days: a whole number from 0 to 365.";
  return null;
}

function PartyFieldsGrid({ draft, set }: { draft: Draft; set: (patch: Partial<Draft>) => void }) {
  return (
    <>
      <Field label="Type">
        <select className={inputClass} value={draft.kind} onChange={(e) => set({ kind: e.target.value as Kind })}>
          <option value="SUPPLIER">Supplier</option>
          <option value="CUSTOMER">Customer</option>
          <option value="BOTH">Both</option>
        </select>
      </Field>
      <Field label="Name">
        <input className={inputClass} value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} required autoComplete="organization" />
      </Field>
      <Field label="GSTIN (optional)">
        <input className={`${inputClass} uppercase`} value={draft.gstin} maxLength={15} onChange={(e) => set({ gstin: e.target.value })} autoCapitalize="characters" spellCheck={false} />
      </Field>
      <Field label="Phone (optional)">
        <input className={inputClass} type="tel" inputMode="tel" value={draft.phone} maxLength={20} onChange={(e) => set({ phone: e.target.value })} />
      </Field>
      <Field label="Email (optional)">
        <input className={inputClass} type="email" value={draft.email} maxLength={120} onChange={(e) => set({ email: e.target.value })} />
      </Field>
      <Field label="Credit days" hint="Days they give you (or you give them) to pay.">
        <input className={inputClass} inputMode="numeric" value={draft.creditDays} onChange={(e) => set({ creditDays: e.target.value })} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Address (optional)">
          <textarea className={inputClass} rows={2} value={draft.address} maxLength={400} onChange={(e) => set({ address: e.target.value })} />
        </Field>
      </div>
    </>
  );
}

/** Add a supplier or customer (POST parties), then open their page. */
export function AddPartyForm({ shopId, defaultKind, shopQuery = "" }: { shopId: string; defaultKind: Kind; shopQuery?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({ kind: defaultKind, name: "", gstin: "", phone: "", email: "", address: "", creditDays: "" });
  const [opening, setOpening] = useState("");
  const [openingSide, setOpeningSide] = useState<"OWE" | "OWED">(defaultKind === "CUSTOMER" ? "OWED" : "OWE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = check(draft);
    if (problem) {
      setError(problem);
      return;
    }
    const openingPaise = opening.trim() ? parseRupees(opening) : 0;
    if (openingPaise == null) {
      setError("Opening balance: enter an amount in rupees.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const party = await accountsApi<{ id: string }>(shopId, "parties", { body: { ...toBody(draft), openingBalancePaise: openingSide === "OWE" ? openingPaise : -openingPaise } });
      router.push(`/shop/accounts/parties/${party.id}${shopQuery}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} aria-expanded={false}>
        + Add {defaultKind === "CUSTOMER" ? "customer" : "supplier"}
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-2 rounded-2xl border border-[var(--gk-line)] bg-white p-3 sm:grid-cols-2" aria-label="Add party">
      <PartyFieldsGrid draft={draft} set={(p) => setDraft((d) => ({ ...d, ...p }))} />
      <Field label="Opening balance (₹, optional)" hint="What was due before you started using these books.">
        <input className={inputClass} inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0.00" />
      </Field>
      <Field label="Opening balance is">
        <select className={inputClass} value={openingSide} onChange={(e) => setOpeningSide(e.target.value as "OWE" | "OWED")}>
          <option value="OWE">What I owe them</option>
          <option value="OWED">What they owe me</option>
        </select>
      </Field>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save party"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Close
        </Button>
      </div>
      <div className="sm:col-span-2">
        <FormError message={error} />
      </div>
    </form>
  );
}

/** Edit a party's details (PATCH parties/{id}). The opening balance is not edited here. */
export function EditPartyForm({ shopId, party }: { shopId: string; party: PartyFields }) {
  const router = useRouter();
  const initial: Draft = {
    kind: party.kind,
    name: party.name,
    gstin: party.gstin ?? "",
    phone: party.phone ?? "",
    email: party.email ?? "",
    address: party.address ?? "",
    creditDays: String(party.creditDays),
  };
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = check(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await accountsApi(shopId, `parties/${party.id}`, { method: "PATCH", body: toBody(draft) });
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => { setDraft(initial); setOpen(true); }}>
        Edit details
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-2 rounded-2xl border border-[var(--gk-line)] bg-white p-3 sm:grid-cols-2" aria-label="Edit party">
      <PartyFieldsGrid draft={draft} set={(p) => setDraft((d) => ({ ...d, ...p }))} />
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Close
        </Button>
      </div>
      <div className="sm:col-span-2">
        <FormError message={error} />
      </div>
    </form>
  );
}
