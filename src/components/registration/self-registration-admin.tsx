"use client";

/**
 * Module 3 admin: fee plans, distributor types and distributors (with their
 * commission), and referral codes for self-registration (distributor, usage
 * limit). Commission: FLAT in rupees, or a percentage of the fee.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

interface Tier { id: string; code: string; label: string; description: string | null; amountPaise: number; isActive: boolean; sortOrder: number }
interface DType { id: string; code: string; name: string; commissionType: "FLAT" | "PERCENT"; commissionValue: number; isActive: boolean }
interface Dist {
  distributor: { id: string; distributorTypeId: string; name: string; phoneE164: string | null; email: string | null; district: string | null; state: string | null; status: "ACTIVE" | "INACTIVE"; commissionType: "FLAT" | "PERCENT" | null; commissionValue: number | null; note: string | null };
  typeName: string;
  typeCommissionType: "FLAT" | "PERCENT";
  typeCommissionValue: number;
  codes: number;
  shops: number;
  commissionPaise: number;
}
interface Code { id: string; code: string; label: string | null; status: string; expiresAt: string | null; distributorId: string | null; distributorName: string | null; maxUses: number | null; used: number; held: number }

const rupees = (p: number) => `₹${(Number(p) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const describe = (type: "FLAT" | "PERCENT", value: number) => (type === "FLAT" ? rupees(value) : `${value / 100}% of the fee`);
/** Form value (₹ or %) → stored value (paise or basis points). */
const toStored = (type: "FLAT" | "PERCENT", text: string) => Math.round(Number(text) * 100);
const fromStored = (value: number) => String(value / 100);

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? "Could not save.");
  return data;
}

export function SelfRegistrationAdmin({ tiers, types, distributors, codes, canEditTiers, open }: { tiers: Tier[]; types: DType[]; distributors: Dist[]; codes: Code[]; canEditTiers: boolean; open: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      {!open ? <Alert tone="warning">Self-registration is switched off. Turn it on in Business rules → selfRegistration.enabled.</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Fee plans</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {tiers.map((t) => <TierCard key={t.id} tier={t} disabled={!canEditTiers} onSave={(body) => run(() => send(`/api/admin/registration-fee-tiers/${t.code}`, "PUT", body), `${t.label} saved.`)} />)}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Distributor types</h2>
        <Card className="divide-y divide-cream-200">
          {types.map((t) => (
            <TypeRow key={t.id} type={t} onSave={(body) => run(() => send(`/api/admin/distributor-types/${t.id}`, "PATCH", body), `${t.name} saved.`)} />
          ))}
          <TypeRow onSave={(body) => run(() => send("/api/admin/distributor-types", "POST", body), "Distributor type added.")} />
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Distributors</h2>
        <Card className="divide-y divide-cream-200">
          {distributors.map((d) => (
            <DistributorRow key={d.distributor.id} row={d} types={types} onSave={(body) => run(() => send(`/api/admin/distributors/${d.distributor.id}`, "PATCH", body), `${d.distributor.name} saved.`)} />
          ))}
          {types.length ? <DistributorRow types={types} onSave={(body) => run(() => send("/api/admin/distributors", "POST", body), "Distributor added.")} /> : <p className="p-3 text-sm text-ink-500">Add a distributor type first.</p>}
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Referral codes</h2>
        <Card className="divide-y divide-cream-200">
          {codes.map((c) => (
            <CodeRow key={c.id} code={c} distributors={distributors} onSave={(body) => run(() => send(`/api/referral-codes/${c.id}`, "PATCH", body), `${c.code} saved.`)} />
          ))}
          <CodeRow distributors={distributors} onSave={(body) => run(() => send("/api/referral-codes", "POST", body), "Referral code added.")} />
        </Card>
      </section>
    </div>
  );
}

function TierCard({ tier, disabled, onSave }: { tier: Tier; disabled: boolean; onSave: (body: unknown) => void }) {
  const [label, setLabel] = useState(tier.label);
  const [amount, setAmount] = useState(fromStored(tier.amountPaise));
  const [description, setDescription] = useState(tier.description ?? "");
  const [active, setActive] = useState(tier.isActive);
  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-ink-500">{tier.code}</span>
        <Badge tone={tier.isActive ? "success" : "neutral"}>{tier.isActive ? "offered" : "off"}</Badge>
      </div>
      <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} disabled={disabled} aria-label="Plan name" />
      <Field label="Fee (₹)"><input className={inputClass} type="number" min={0} step="1" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={disabled} /></Field>
      <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What the plan includes (shown to applicants)" disabled={disabled} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={disabled} /> Offer this plan</label>
      <Button size="sm" disabled={disabled} onClick={() => onSave({ label, description: description || null, amountPaise: Math.round(Number(amount) * 100), isActive: active, sortOrder: tier.sortOrder })}>Save</Button>
    </Card>
  );
}

function CommissionInputs({ type, value, onType, onValue, allowDefault }: { type: string; value: string; onType: (v: string) => void; onValue: (v: string) => void; allowDefault?: boolean }) {
  return (
    <div className="flex gap-2">
      <select className={inputClass} value={type} onChange={(e) => onType(e.target.value)} aria-label="Commission type">
        {allowDefault ? <option value="">Type default</option> : null}
        <option value="PERCENT">% of fee</option>
        <option value="FLAT">Flat ₹</option>
      </select>
      {type ? <input className={inputClass} type="number" min={0} step="0.01" value={value} onChange={(e) => onValue(e.target.value)} aria-label="Commission" /> : null}
    </div>
  );
}

function TypeRow({ type, onSave }: { type?: DType; onSave: (body: unknown) => void }) {
  const [code, setCode] = useState(type?.code ?? "");
  const [name, setName] = useState(type?.name ?? "");
  const [ctype, setCtype] = useState<string>(type?.commissionType ?? "PERCENT");
  const [cvalue, setCvalue] = useState(type ? fromStored(type.commissionValue) : "");
  const [active, setActive] = useState(type?.isActive ?? true);
  return (
    <div className="grid gap-2 p-3 sm:grid-cols-5 sm:items-end">
      <input className={inputClass} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CODE" aria-label="Type code" />
      <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={type ? "" : "New type, e.g. District distributor"} aria-label="Type name" />
      <CommissionInputs type={ctype} value={cvalue} onType={setCtype} onValue={setCvalue} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
      <Button size="sm" variant={type ? "secondary" : "primary"} onClick={() => onSave({ code, name, commissionType: ctype, commissionValue: toStored(ctype as "FLAT", cvalue), isActive: active })}>{type ? "Save" : "Add type"}</Button>
    </div>
  );
}

function DistributorRow({ row, types, onSave }: { row?: Dist; types: DType[]; onSave: (body: unknown) => void }) {
  const d = row?.distributor;
  const [typeId, setTypeId] = useState(d?.distributorTypeId ?? types[0]?.id ?? "");
  const [name, setName] = useState(d?.name ?? "");
  const [phone, setPhone] = useState(d?.phoneE164 ?? "");
  const [district, setDistrict] = useState(d?.district ?? "");
  const [ctype, setCtype] = useState<string>(d?.commissionType ?? "");
  const [cvalue, setCvalue] = useState(d?.commissionValue != null ? fromStored(d.commissionValue) : "");
  const [active, setActive] = useState((d?.status ?? "ACTIVE") === "ACTIVE");
  return (
    <div className="space-y-2 p-3">
      {row ? (
        <p className="text-xs text-ink-500">
          {row.codes} codes · {row.shops} shops · commission {rupees(row.commissionPaise)} · type default {describe(row.typeCommissionType, row.typeCommissionValue)}
          {d?.commissionType ? ` · own rate ${describe(d.commissionType, d.commissionValue!)}` : ""}
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-3">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Distributor name" aria-label="Distributor name" />
        <select className={inputClass} value={typeId} onChange={(e) => setTypeId(e.target.value)} aria-label="Distributor type">
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input className={inputClass} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91XXXXXXXXXX" aria-label="Mobile" />
        <input className={inputClass} value={district} onChange={(e) => setDistrict(e.target.value)} placeholder="District" aria-label="District" />
        <CommissionInputs type={ctype} value={cvalue} onType={setCtype} onValue={setCvalue} allowDefault />
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
          <Button size="sm" variant={row ? "secondary" : "primary"} onClick={() => onSave({
            distributorTypeId: typeId,
            name,
            phoneE164: phone || null,
            district: district || null,
            status: active ? "ACTIVE" : "INACTIVE",
            commissionType: ctype || null,
            commissionValue: ctype ? toStored(ctype as "FLAT", cvalue) : null,
          })}>{row ? "Save" : "Add distributor"}</Button>
        </div>
      </div>
    </div>
  );
}

function CodeRow({ code, distributors, onSave }: { code?: Code; distributors: Dist[]; onSave: (body: unknown) => void }) {
  const [value, setValue] = useState(code?.code ?? "");
  const [label, setLabel] = useState(code?.label ?? "");
  const [distributorId, setDistributorId] = useState(code?.distributorId ?? "");
  const [maxUses, setMaxUses] = useState(code?.maxUses != null ? String(code.maxUses) : "");
  const [expiresAt, setExpiresAt] = useState(code?.expiresAt ?? "");
  const [status, setStatus] = useState(code?.status ?? "ACTIVE");
  return (
    <div className="space-y-2 p-3">
      {code ? (
        <p className="text-xs text-ink-500">
          <b className="text-ink-900">{code.code}</b> · used {code.used}{code.maxUses ? ` of ${code.maxUses}` : ""}{code.held ? ` · ${code.held} waiting for payment` : ""} · link: /shop/join?code={code.code}
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-3">
        {!code ? <input className={inputClass} value={value} onChange={(e) => setValue(e.target.value.toUpperCase())} placeholder="New code, e.g. PUNE-RAVI" aria-label="Code" /> : null}
        <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" aria-label="Label" />
        <select className={inputClass} value={distributorId} onChange={(e) => setDistributorId(e.target.value)} aria-label="Distributor">
          <option value="">No distributor (no commission)</option>
          {distributors.map((d) => <option key={d.distributor.id} value={d.distributor.id}>{d.distributor.name}</option>)}
        </select>
        <input className={inputClass} type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="Usage limit (empty = none)" aria-label="Usage limit" />
        <input className={inputClass} type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} aria-label="Expires" />
        <div className="flex items-center gap-2">
          {code ? (
            <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="EXPIRED">Expired</option>
            </select>
          ) : null}
          <Button size="sm" variant={code ? "secondary" : "primary"} onClick={() => onSave({
            ...(code ? { status } : { code: value }),
            label: label || null,
            distributorId: distributorId || null,
            maxUses: maxUses ? Number(maxUses) : null,
            expiresAt: expiresAt || null,
          })}>{code ? "Save" : "Add code"}</Button>
        </div>
      </div>
    </div>
  );
}
