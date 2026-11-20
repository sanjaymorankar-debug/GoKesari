"use client";

/**
 * Health admin → Drug master (search, add / edit, CSV import of medicines and ICD-10 codes, sample files)
 * and Lists (home-care categories, kept in consultant categories; the medical equipment master).
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { DRUG_FORMS, DRUG_SCHEDULES, TELE_LIST_LABELS, TELE_LISTS } from "@/lib/health/constants";
import { Badge, Button, Field, inputClass } from "@/components/ui";
import { api, Panel, Tile } from "./api";
import { ADMIN_API, card, downloadText, Loading, Nothing, type Post } from "./admin-common";

interface Drug {
  id: string;
  genericName: string;
  brandName: string | null;
  strength: string | null;
  form: string;
  manufacturer: string | null;
  schedule: string;
  rxRequired: boolean;
  teleList: string;
  onlineSaleAllowed: boolean;
  status: string;
}

interface Stats {
  drugs: number;
  active: number;
  prohibitedTele: number;
  icd10: number;
}

const SAMPLE_DRUGS = [
  "generic_name,brand_name,strength,form,schedule,rx_required,tele_list,online_sale_allowed,manufacturer",
  "Paracetamol,Crocin,500 mg,TABLET,OTC,no,O,yes,GSK",
  "Amoxicillin,Mox,500 mg,CAPSULE,H,yes,A,yes,Sun Pharma",
  "Alprazolam,Alprax,0.25 mg,TABLET,H1,yes,PROHIBITED,no,Torrent",
  '"Cough syrup, dry",Ascoril D,100 ml,SYRUP,H,yes,A,yes,Glenmark',
].join("\r\n");
const SAMPLE_ICD = ["code,title,chapter", 'R50.9,"Fever, unspecified",XVIII', 'J06.9,"Acute upper respiratory infection, unspecified",X', "E11.9,Type 2 diabetes mellitus without complications,IV"].join("\r\n");

const scheduleTone = (s: string) => (s === "X" || s === "NDPS" ? "danger" : s === "H1" ? "warning" : s === "OTC" ? "success" : "neutral");
const teleTone = (t: string) => (t === "PROHIBITED" ? "danger" : t === "B" ? "warning" : t === "O" ? "success" : "info");

const blankDrug = (): Partial<Drug> => ({ genericName: "", brandName: "", strength: "", form: "TABLET", manufacturer: "", schedule: "H", rxRequired: true, teleList: "A", onlineSaleAllowed: true, status: "ACTIVE" });

export function DrugMaster({ post }: { post: Post }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Drug[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [edit, setEdit] = useState<Partial<Drug> | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: "drugs" });
    if (q.trim()) p.set("q", q.trim());
    const res = await api<{ drugs: Drug[]; stats: Stats }>(`${ADMIN_API}?${p.toString()}`);
    setRows(res.drugs);
    setStats(res.stats);
  }, [q]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the search changes
    void load();
  }, [load]);
  const importFile = async (action: "importDrugs" | "importIcd", file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const csv = await file.text();
      const res = await post<{ added: number; updated?: number; errors?: string[] }>({ action, csv }, (r) => (action === "importDrugs" ? `Medicines: ${r.added} added, ${r.updated ?? 0} updated.` : `ICD-10: ${r.added} codes added or updated.`));
      if (res?.errors?.length) setResult(`Lines not imported:\n${res.errors.join("\n")}`);
      await load();
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!edit) return;
    const drug = { ...edit, brandName: edit.brandName || null, strength: edit.strength || null, manufacturer: edit.manufacturer || null };
    if (await post({ action: "drug", drug }, `${edit.genericName} saved.`)) {
      setEdit(null);
      await load();
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="health-drugs">
      {stats ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="Medicines" value={stats.drugs} hint={`${stats.active} active`} tone="ink" />
          <Tile label="Never by teleconsult" value={stats.prohibitedTele} tone="amber" hint="Schedule X / NDPS" />
          <Tile label="ICD-10 codes" value={stats.icd10} tone="teal" />
          <div className="flex items-center">
            <Button onClick={() => setEdit(blankDrug())} data-testid="health-drug-add" className="w-full">
              + Add medicine
            </Button>
          </div>
        </div>
      ) : null}
      {edit ? (
        <Panel title={edit.id ? `Edit ${edit.genericName}` : "New medicine"}>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Generic name">
              <input className={inputClass} value={edit.genericName ?? ""} onChange={(e) => setEdit({ ...edit, genericName: e.target.value })} data-testid="health-drug-generic" />
            </Field>
            <Field label="Brand">
              <input className={inputClass} value={edit.brandName ?? ""} onChange={(e) => setEdit({ ...edit, brandName: e.target.value })} />
            </Field>
            <Field label="Strength">
              <input className={inputClass} value={edit.strength ?? ""} onChange={(e) => setEdit({ ...edit, strength: e.target.value })} placeholder="500 mg" />
            </Field>
            <Field label="Form">
              <select className={inputClass} value={edit.form} onChange={(e) => setEdit({ ...edit, form: e.target.value })}>
                {DRUG_FORMS.map((f) => (
                  <option key={f} value={f}>
                    {f.toLowerCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Schedule" hint="X and NDPS are never allowed by teleconsultation or online sale.">
              <select className={inputClass} value={edit.schedule} onChange={(e) => setEdit({ ...edit, schedule: e.target.value })}>
                {DRUG_SCHEDULES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Telemedicine list">
              <select className={inputClass} value={edit.teleList} onChange={(e) => setEdit({ ...edit, teleList: e.target.value })}>
                {TELE_LISTS.map((t) => (
                  <option key={t} value={t}>
                    {TELE_LIST_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Manufacturer">
              <input className={inputClass} value={edit.manufacturer ?? ""} onChange={(e) => setEdit({ ...edit, manufacturer: e.target.value })} />
            </Field>
            <div className="flex flex-col justify-center gap-1 text-sm sm:col-span-2">
              <label className="flex min-h-10 items-center gap-2">
                <input type="checkbox" checked={Boolean(edit.rxRequired)} onChange={(e) => setEdit({ ...edit, rxRequired: e.target.checked })} /> Needs a prescription
              </label>
              <label className="flex min-h-10 items-center gap-2">
                <input type="checkbox" checked={Boolean(edit.onlineSaleAllowed)} onChange={(e) => setEdit({ ...edit, onlineSaleAllowed: e.target.checked })} /> Online sale allowed
              </label>
              <label className="flex min-h-10 items-center gap-2">
                <input type="checkbox" checked={edit.status !== "INACTIVE"} onChange={(e) => setEdit({ ...edit, status: e.target.checked ? "ACTIVE" : "INACTIVE" })} /> Active (shown on the prescription pad)
              </label>
            </div>
          </div>
          <div className="mt-2 flex gap-2">
            <Button onClick={save} data-testid="health-drug-save">
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
          </div>
        </Panel>
      ) : null}
      <details className={card} open={busy || Boolean(result)} data-testid="health-drug-import-panel">
        <summary className="min-h-10 cursor-pointer py-2 font-extrabold text-ink-900">Import from a CSV file</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1 text-sm">
            <label className="font-semibold" htmlFor="health-drug-csv">
              Medicines
            </label>
            <input id="health-drug-csv" type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => importFile("importDrugs", e.target.files?.[0])} data-testid="health-drug-import" className="text-sm" />
            <p className="text-xs text-ink-600">Same generic + brand + strength + form updates the medicine; anything else is added.</p>
            <button type="button" className="min-h-10 self-start text-xs font-bold text-kesari-800 underline" onClick={() => downloadText("drug-master-sample.csv", SAMPLE_DRUGS)} data-testid="health-drug-sample">
              Download a sample file
            </button>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label className="font-semibold" htmlFor="health-icd-csv">
              ICD-10 diagnosis codes
            </label>
            <input id="health-icd-csv" type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => importFile("importIcd", e.target.files?.[0])} data-testid="health-icd-import" className="text-sm" />
            <p className="text-xs text-ink-600">Columns: code, title, chapter (optional). An existing code gets the new title.</p>
            <button type="button" className="min-h-10 self-start text-xs font-bold text-kesari-800 underline" onClick={() => downloadText("icd10-sample.csv", SAMPLE_ICD)}>
              Download a sample file
            </button>
          </div>
        </div>
        {busy ? <p className="mt-2 text-sm text-ink-600">Importing…</p> : null}
        {result ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-amber-50 p-2 text-xs text-amber-900">{result}</pre> : null}
      </details>
      <input className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search generic or brand name" aria-label="Search medicines" data-testid="health-drug-search" />
      {rows === null ? <Loading /> : rows.length === 0 ? <Nothing>No medicines match.</Nothing> : null}
      <ul className="flex flex-col gap-1.5">
        {(rows ?? []).map((d) => (
          <li key={d.id} className={`${card} flex flex-wrap items-center justify-between gap-2 ${d.status === "INACTIVE" ? "opacity-60" : ""}`} data-testid="health-drug-row">
            <div className="min-w-0">
              <p className="font-bold text-ink-900">
                {d.genericName}
                {d.strength ? ` ${d.strength}` : ""} <span className="font-normal text-ink-600">{d.brandName ? `(${d.brandName})` : ""}</span>
              </p>
              <p className="flex flex-wrap gap-1 text-xs">
                <Badge>{d.form.toLowerCase()}</Badge>
                <Badge tone={scheduleTone(d.schedule)}>Schedule {d.schedule}</Badge>
                <Badge tone={teleTone(d.teleList)}>{d.teleList === "PROHIBITED" ? "No teleconsult" : `Tele list ${d.teleList}`}</Badge>
                <Badge tone={d.onlineSaleAllowed ? "success" : "danger"}>{d.onlineSaleAllowed ? "Online sale" : "No online sale"}</Badge>
                {d.rxRequired ? <Badge tone="info">Rx</Badge> : <Badge>No Rx</Badge>}
                {d.status === "INACTIVE" ? <Badge tone="warning">Off</Badge> : null}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setEdit(d)}>
              Edit
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface CareCategory {
  id: string;
  name: string;
  groupName: string;
  requiredDoc: string;
  status: string;
  providers: number;
}

interface Equipment {
  id: string;
  name: string;
  slug: string;
  category: string;
  description: string | null;
  rxRequired: boolean;
  status: string;
  sortOrder: number;
  listings: number;
}

const blankItem = (): Partial<Equipment> => ({ name: "", slug: "", category: "Mobility", description: "", rxRequired: false, status: "ACTIVE", sortOrder: 100 });

export function Lists({ post }: { post: Post }) {
  const [cats, setCats] = useState<CareCategory[] | null>(null);
  const [items, setItems] = useState<Equipment[] | null>(null);
  const [edit, setEdit] = useState<Partial<Equipment> | null>(null);
  const load = useCallback(async () => {
    const [c, e] = await Promise.all([api<{ categories: CareCategory[] }>(`${ADMIN_API}?view=careCategories`), api<{ items: Equipment[] }>(`${ADMIN_API}?view=equipment`)]);
    setCats(c.categories);
    setItems(e.items);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) once
    void load();
  }, [load]);
  const save = async () => {
    if (!edit) return;
    const item = { ...edit, slug: edit.slug || null, description: edit.description || null, sortOrder: Number(edit.sortOrder ?? 100) };
    delete (item as { listings?: number }).listings;
    if (await post({ action: "equipment", item }, `${edit.name} saved.`)) {
      setEdit(null);
      await load();
    }
  };
  const remove = async (e: Equipment) => {
    if (!window.confirm(`Delete ${e.name} from the equipment list?`)) return;
    if (await post({ action: "deleteEquipment", id: e.id }, `${e.name} deleted.`)) await load();
  };
  const groups = [...new Set((items ?? []).map((i) => i.category))];
  return (
    <div className="flex flex-col gap-3" data-testid="health-lists">
      <Panel
        title="Home-care categories"
        action={
          <Link href="/admin/consult?tab=categories" className="text-sm font-bold text-kesari-800 underline" data-testid="health-care-categories-edit">
            Edit in Consultants → Categories
          </Link>
        }
      >
        {cats === null ? (
          <Loading />
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {cats.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-cream-100 py-1">
                <span>
                  <strong>{c.name}</strong> <span className="text-xs text-ink-600">({c.groupName})</span> {c.status === "INACTIVE" ? <Badge tone="warning">Off</Badge> : null}
                </span>
                <span className="text-xs text-ink-600">
                  {c.requiredDoc === "NONE" ? "No certificate" : "Certificate needed"} · {c.providers} provider(s)
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-ink-600">Home-care categories live in the &quot;Home care&quot; group of the consultant categories (physiotherapists are under Doctors and clinics).</p>
      </Panel>
      <Panel
        title="Medical equipment list"
        action={
          <Button size="sm" onClick={() => setEdit(blankItem())} data-testid="health-equipment-add">
            + Add item
          </Button>
        }
      >
        {edit ? (
          <div className="mb-3 rounded-xl bg-cream-50 p-2">
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Name">
                <input className={inputClass} value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} data-testid="health-equipment-name" />
              </Field>
              <Field label="Group">
                <input className={inputClass} value={edit.category ?? ""} onChange={(e) => setEdit({ ...edit, category: e.target.value })} list="health-equipment-groups" />
                <datalist id="health-equipment-groups">
                  {groups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </Field>
              <Field label="Short name (slug)" hint="Blank: made from the name">
                <input className={inputClass} value={edit.slug ?? ""} onChange={(e) => setEdit({ ...edit, slug: e.target.value.toLowerCase() })} />
              </Field>
              <Field label="Description">
                <input className={inputClass} value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
              </Field>
              <Field label="Order">
                <input className={inputClass} type="number" min={0} value={edit.sortOrder ?? 100} onChange={(e) => setEdit({ ...edit, sortOrder: Number(e.target.value) })} />
              </Field>
              <div className="flex flex-col justify-center text-sm">
                <label className="flex min-h-10 items-center gap-2">
                  <input type="checkbox" checked={Boolean(edit.rxRequired)} onChange={(e) => setEdit({ ...edit, rxRequired: e.target.checked })} /> Needs a prescription
                </label>
                <label className="flex min-h-10 items-center gap-2">
                  <input type="checkbox" checked={edit.status !== "INACTIVE"} onChange={(e) => setEdit({ ...edit, status: e.target.checked ? "ACTIVE" : "INACTIVE" })} /> Active
                </label>
              </div>
            </div>
            <div className="mt-2 flex gap-2">
              <Button onClick={save} data-testid="health-equipment-save">
                Save
              </Button>
              <Button variant="ghost" onClick={() => setEdit(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {items === null ? <Loading /> : items.length === 0 ? <Nothing>No equipment yet.</Nothing> : null}
        {groups.map((g) => (
          <div key={g} className="mb-2">
            <p className="text-xs font-bold uppercase tracking-wide text-ink-600">{g}</p>
            <ul className="flex flex-col">
              {(items ?? [])
                .filter((i) => i.category === g)
                .map((i) => (
                  <li key={i.id} className={`flex flex-wrap items-center justify-between gap-2 border-b border-cream-100 py-1 text-sm ${i.status === "INACTIVE" ? "text-ink-400" : ""}`} data-testid="health-equipment-row">
                    <span>
                      <strong>{i.name}</strong> {i.rxRequired ? <Badge tone="info">Rx</Badge> : null} {i.status === "INACTIVE" ? <Badge tone="warning">Off</Badge> : null}
                      <span className="block text-xs text-ink-600">
                        {i.slug} · {i.listings} store listing(s)
                      </span>
                    </span>
                    <span className="flex gap-1">
                      <Button size="sm" variant="secondary" onClick={() => setEdit(i)}>
                        Edit
                      </Button>
                      {i.listings === 0 ? (
                        <Button size="sm" variant="ghost" onClick={() => remove(i)}>
                          Delete
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </Panel>
    </div>
  );
}
