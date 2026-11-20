"use client";

/**
 * Admin / operator Puja Samagri screen (docs/puja-samagri-2026-11, brief §6). Tabs:
 *   Catalogue (edit, HSN/GST "to verify with CA", retire, merge, CSV export / import)
 *   Review queue (owner types and products: approve / reject / merge with reason)
 *   Festivals (banner + kit promotion by IST date range)
 *   Configuration (type on/off, FSSAI for edible lines, seed stock, standard fee)
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PUJA_FESTIVALS, dateToIstInput, formatIst, istInputToDate } from "@/lib/puja";

import { useLoad } from "./use-load";

type Tab = "catalogue" | "review" | "festivals" | "config";

interface Item {
  productId: string;
  code: string;
  name: string;
  nameHi: string | null;
  nameMr: string | null;
  synonyms: string[];
  categoryId: string;
  categoryName: string;
  typeName: string | null;
  variant: string | null;
  sellUnit: string | null;
  kind: "PACKAGED" | "LOOSE";
  mrpPaise: number | null;
  hsnCode: string | null;
  gstRateBp: number | null;
  taxToVerify: boolean;
  perishable: boolean;
  edible: boolean;
  festivals: string[];
  approvalStatus: string;
  isActive: boolean;
  mergedIntoProductId: string | null;
}
interface Submission {
  kind: "TYPE" | "PRODUCT";
  id: string;
  name: string;
  nameHi: string | null;
  nameMr: string | null;
  categoryName: string;
  typeName: string | null;
  shopName: string | null;
  createdByName: string | null;
  createdAt: string;
  detail: string;
  mergeCandidates: { id: string; name: string }[];
}
interface Festival {
  id: string;
  festivalKey: string;
  title: string;
  titleHi: string | null;
  titleMr: string | null;
  subtitle: string | null;
  startsAt: string;
  endsAt: string;
  active: boolean;
  homeBannerId: string | null;
}
interface Config {
  enabled: boolean;
  label: string;
  edibleNeedsFssai: boolean;
  seedDefaultStock: number;
  counts: { products: number; categories: number; types: number; shops: number; taxToVerify: number; edible: number };
}

const btn = "min-h-10 rounded-xl px-3 text-sm font-semibold disabled:bg-cream-200 disabled:text-ink-600";
const primary = `${btn} bg-kesari-600 text-white hover:bg-kesari-800`;
const secondary = `${btn} border border-cream-200 bg-white text-ink-800 hover:bg-cream-100`;
const danger = `${btn} bg-red-700 text-white hover:bg-red-800`;
const input = "mt-1 min-h-10 w-full rounded-lg border border-cream-200 px-2 text-sm";
const rupees = (p: number | null) => (p == null ? "" : String(p / 100));

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  const res = await fetch(url, { ...init, headers: init?.body instanceof FormData ? init.headers : { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, message: body?.error?.message ?? "Something went wrong. Please try again." };
  return { ok: true, data: body as T };
}

function Notice({ tone, children }: { tone: "ok" | "error"; children: React.ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-xl px-3 py-2 text-sm ${tone === "ok" ? "bg-green-50 text-green-900" : "bg-red-50 text-red-800"}`}>
      {children}
    </div>
  );
}

export function PujaAdmin({ initialTab, categories, canFestivals }: { initialTab: Tab; categories: { id: string; name: string }[]; canFestivals: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabs: { key: Tab; label: string }[] = [
    { key: "catalogue", label: "Catalogue" },
    { key: "review", label: "Review queue" },
    ...(canFestivals ? [{ key: "festivals" as const, label: "Festivals" }] : []),
    { key: "config", label: "Configuration" },
  ];
  return (
    <div className="space-y-3" data-testid="puja-admin">
      <div className="flex flex-wrap gap-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => {
              setTab(t.key);
              router.replace(`?tab=${t.key}`, { scroll: false });
            }}
            className={`min-h-10 rounded-full border px-3 text-sm font-semibold ${tab === t.key ? "border-kesari-600 bg-kesari-600 text-white" : "border-cream-200 bg-white text-ink-800"}`}
            data-testid={`puja-admin-tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "catalogue" ? <CatalogueTab categories={categories} /> : tab === "review" ? <ReviewTab /> : tab === "festivals" ? <FestivalsTab /> : <ConfigTab />}
    </div>
  );
}

/* ------------------------------------------------------------------ catalogue */

function CatalogueTab({ categories }: { categories: { id: string; name: string }[] }) {
  const [filters, setFilters] = useState({ q: "", categoryId: "", taxToVerify: false, includeRetired: false });
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [editing, setEditing] = useState<Item | null>(null);
  const [merge, setMerge] = useState({ sourceCode: "", targetCode: "", reason: "" });
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ limit: "200" });
    if (filters.q) p.set("q", filters.q);
    if (filters.categoryId) p.set("categoryId", filters.categoryId);
    if (filters.taxToVerify) p.set("taxToVerify", "1");
    if (filters.includeRetired) p.set("includeRetired", "1");
    const r = await api<{ items: Item[]; total: number }>(`/api/admin/puja/catalogue?${p}`);
    if (r.ok) {
      setItems(r.data.items);
      setTotal(r.data.total);
    }
  }, [filters]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  async function save(item: Item, patch: Record<string, unknown>) {
    const r = await api(`/api/admin/puja/catalogue/${item.productId}`, { method: "PATCH", body: JSON.stringify(patch) });
    if (!r.ok) return setMessage({ tone: "error", text: r.message });
    setMessage({ tone: "ok", text: `Saved ${item.code}.` });
    setEditing(null);
    await load();
  }
  async function doMerge() {
    const find = async (code: string) => (await api<{ items: Item[] }>(`/api/admin/puja/catalogue?q=${encodeURIComponent(code)}&includeRetired=1&limit=50`));
    const [s, t] = await Promise.all([find(merge.sourceCode), find(merge.targetCode)]);
    const source = s.ok ? s.data.items.find((i) => i.code === merge.sourceCode.trim()) : undefined;
    const target = t.ok ? t.data.items.find((i) => i.code === merge.targetCode.trim()) : undefined;
    if (!source || !target) return setMessage({ tone: "error", text: "Enter the product codes (P00123) of the duplicate and the product to keep." });
    const r = await api<{ merged: string; into: string; shopListingsKept: number }>(`/api/admin/puja/catalogue/merge`, {
      method: "POST",
      body: JSON.stringify({ sourceId: source.productId, targetId: target.productId, reason: merge.reason || null }),
    });
    if (!r.ok) return setMessage({ tone: "error", text: r.message });
    setMessage({ tone: "ok", text: `Merged “${r.data.merged}” into “${r.data.into}”; ${r.data.shopListingsKept} shop listings kept as they are.` });
    setMerge({ sourceCode: "", targetCode: "", reason: "" });
    await load();
  }
  async function upload(file: File) {
    setImporting(true);
    const form = new FormData();
    form.set("file", file);
    const r = await api<{ updated: number; created: number; errors: { row: number; message: string }[] }>(`/api/admin/puja/catalogue/import`, { method: "POST", body: form });
    setImporting(false);
    if (!r.ok) return setMessage({ tone: "error", text: r.message });
    setMessage({
      tone: r.data.errors.length ? "error" : "ok",
      text:
        `${r.data.updated} updated, ${r.data.created} added.` +
        (r.data.errors.length ? ` ${r.data.errors.length} rows skipped: ${r.data.errors.slice(0, 5).map((e) => `row ${e.row}: ${e.message}`).join("; ")}` : ""),
    });
    await load();
  }

  return (
    <div className="space-y-3" data-testid="puja-admin-catalogue">
      <div className="grid grid-cols-2 gap-2 rounded-xl border border-cream-200 bg-white p-2 sm:grid-cols-6">
        <label className="col-span-2 text-xs font-medium text-ink-700">
          Search (code, English, हिंदी, मराठी, synonyms)
          <input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} className={input} />
        </label>
        <label className="col-span-2 text-xs font-medium text-ink-700">
          Category
          <select value={filters.categoryId} onChange={(e) => setFilters({ ...filters, categoryId: e.target.value })} className={input}>
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-10 items-center gap-2 self-end text-sm">
          <input type="checkbox" className="h-4 w-4" checked={filters.taxToVerify} onChange={(e) => setFilters({ ...filters, taxToVerify: e.target.checked })} /> HSN/GST to verify
        </label>
        <label className="flex min-h-10 items-center gap-2 self-end text-sm">
          <input type="checkbox" className="h-4 w-4" checked={filters.includeRetired} onChange={(e) => setFilters({ ...filters, includeRetired: e.target.checked })} /> Show retired
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-700">{total} products</span>
        <a href={`/api/admin/puja/catalogue/export`} download className={secondary + " inline-flex items-center"} data-testid="puja-admin-export">
          Export CSV
        </a>
        <label className={secondary + " inline-flex cursor-pointer items-center"}>
          {importing ? "Importing…" : "Import CSV"}
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} data-testid="puja-admin-import" />
        </label>
      </div>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <details className="rounded-xl border border-cream-200 bg-white p-2">
        <summary className="cursor-pointer text-sm font-semibold">Merge duplicates</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-4">
          <input placeholder="Duplicate code (P…)" value={merge.sourceCode} onChange={(e) => setMerge({ ...merge, sourceCode: e.target.value })} className={input} />
          <input placeholder="Keep code (P…)" value={merge.targetCode} onChange={(e) => setMerge({ ...merge, targetCode: e.target.value })} className={input} />
          <input placeholder="Reason" value={merge.reason} onChange={(e) => setMerge({ ...merge, reason: e.target.value })} className={input} />
          <button type="button" className={primary} onClick={doMerge} disabled={!merge.sourceCode || !merge.targetCode}>
            Merge
          </button>
        </div>
      </details>
      <div className="overflow-x-auto rounded-xl border border-cream-200 bg-white">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="bg-cream-50 text-left text-xs text-ink-700">
            <tr>
              <th className="p-2">Code</th>
              <th className="p-2">Name (en / hi / mr)</th>
              <th className="p-2">Category · type</th>
              <th className="p-2">MRP</th>
              <th className="p-2">HSN · GST</th>
              <th className="p-2">Flags</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.productId} className={`border-t border-cream-100 ${i.isActive ? "" : "opacity-60"}`}>
                <td className="p-2 font-mono text-xs">{i.code}</td>
                <td className="p-2">
                  <span className="block font-medium">{i.name}</span>
                  <span className="block text-xs text-ink-600">
                    {i.nameHi} · {i.nameMr}
                  </span>
                </td>
                <td className="p-2 text-xs">
                  {i.categoryName}
                  {i.typeName ? ` · ${i.typeName}` : ""}
                </td>
                <td className="p-2">{i.kind === "LOOSE" ? "loose" : i.mrpPaise == null ? "—" : `₹${i.mrpPaise / 100}`}</td>
                <td className="p-2 text-xs">
                  {i.hsnCode ?? "—"} · {i.gstRateBp == null ? "—" : `${i.gstRateBp / 100}%`}
                  {i.taxToVerify ? <span className="ml-1 rounded bg-amber-100 px-1 text-amber-900" data-testid="tax-to-verify">to verify with CA</span> : <span className="ml-1 rounded bg-green-100 px-1 text-green-900">verified</span>}
                </td>
                <td className="p-2 text-xs">
                  {[i.perishable && "perishable", i.edible && "edible", !i.isActive && (i.mergedIntoProductId ? "merged" : "retired"), i.approvalStatus !== "APPROVED" && i.approvalStatus.toLowerCase()]
                    .filter(Boolean)
                    .join(", ")}
                </td>
                <td className="whitespace-nowrap p-2">
                  <button type="button" className="text-xs font-semibold text-kesari-800 underline" onClick={() => setEditing(i)}>
                    Edit
                  </button>{" "}
                  <button type="button" className="text-xs font-semibold text-ink-700 underline" onClick={() => save(i, { active: !i.isActive })}>
                    {i.isActive ? "Retire" : "Bring back"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing ? <EditDialog item={editing} onClose={() => setEditing(null)} onSave={(patch) => save(editing, patch)} /> : null}
    </div>
  );
}

function EditDialog({ item, onClose, onSave }: { item: Item; onClose: () => void; onSave: (patch: Record<string, unknown>) => void }) {
  const [f, setF] = useState({
    name: item.name,
    nameHi: item.nameHi ?? "",
    nameMr: item.nameMr ?? "",
    synonyms: item.synonyms.join(", "),
    mrp: rupees(item.mrpPaise),
    hsnCode: item.hsnCode ?? "",
    gst: item.gstRateBp == null ? "" : String(item.gstRateBp / 100),
    taxToVerify: item.taxToVerify,
    loose: item.kind === "LOOSE",
    perishable: item.perishable,
    edible: item.edible,
    festivals: item.festivals,
  });
  return (
    <div role="dialog" aria-modal="true" aria-label={`Edit ${item.code}`} className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-3">
      <div className="max-h-[90svh] w-full max-w-2xl space-y-2 overflow-y-auto rounded-2xl bg-white p-4">
        <h2 className="text-lg font-bold">
          Edit {item.code} <span className="text-sm font-normal text-ink-600">{item.categoryName}</span>
        </h2>
        <div className="grid grid-cols-2 gap-2">
          <label className="col-span-2 text-xs font-medium">
            Name (English)
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={input} />
          </label>
          <label className="text-xs font-medium">
            Hindi
            <input value={f.nameHi} onChange={(e) => setF({ ...f, nameHi: e.target.value })} className={input} />
          </label>
          <label className="text-xs font-medium">
            Marathi
            <input value={f.nameMr} onChange={(e) => setF({ ...f, nameMr: e.target.value })} className={input} />
          </label>
          <label className="col-span-2 text-xs font-medium">
            Synonyms (comma)
            <input value={f.synonyms} onChange={(e) => setF({ ...f, synonyms: e.target.value })} className={input} />
          </label>
          <label className="text-xs font-medium">
            MRP ₹ (blank = none)
            <input value={f.mrp} disabled={f.loose} onChange={(e) => setF({ ...f, mrp: e.target.value })} className={input} inputMode="decimal" />
          </label>
          <label className="text-xs font-medium">
            HSN
            <input value={f.hsnCode} onChange={(e) => setF({ ...f, hsnCode: e.target.value })} className={input} inputMode="numeric" />
          </label>
          <label className="text-xs font-medium">
            GST %
            <input value={f.gst} onChange={(e) => setF({ ...f, gst: e.target.value })} className={input} inputMode="decimal" />
          </label>
          <label className="flex min-h-10 items-center gap-2 self-end text-sm">
            <input type="checkbox" className="h-4 w-4" checked={!f.taxToVerify} onChange={(e) => setF({ ...f, taxToVerify: !e.target.checked })} /> HSN/GST verified by CA
          </label>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          {(["loose", "perishable", "edible"] as const).map((k) => (
            <label key={k} className="flex min-h-10 items-center gap-2">
              <input type="checkbox" className="h-4 w-4" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {k}
            </label>
          ))}
        </div>
        <fieldset className="flex flex-wrap gap-2 text-xs">
          <legend className="text-xs font-medium">Festivals</legend>
          {PUJA_FESTIVALS.map((x) => (
            <label key={x.key} className="flex items-center gap-1 rounded-full border border-cream-200 px-2 py-1">
              <input
                type="checkbox"
                checked={f.festivals.includes(x.key)}
                onChange={(e) => setF({ ...f, festivals: e.target.checked ? [...f.festivals, x.key] : f.festivals.filter((k) => k !== x.key) })}
              />
              {x.en}
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end gap-2">
          <button type="button" className={secondary} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primary}
            onClick={() =>
              onSave({
                name: f.name,
                nameHi: f.nameHi || null,
                nameMr: f.nameMr || null,
                synonyms: f.synonyms.split(",").map((s) => s.trim()).filter(Boolean),
                mrpPaise: f.loose || f.mrp.trim() === "" ? null : Math.round(Number(f.mrp) * 100),
                hsnCode: f.hsnCode || null,
                gstRateBp: f.gst.trim() === "" ? null : Math.round(Number(f.gst) * 100),
                taxToVerify: f.taxToVerify,
                loose: f.loose,
                perishable: f.perishable,
                edible: f.edible,
                festivals: f.festivals,
              })
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- review */

function ReviewTab() {
  const [rows, setRows] = useState<Submission[] | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ submissions: Submission[] }>("/api/admin/puja/submissions");
    if (r.ok) setRows(r.data.submissions);
    else setMessage({ tone: "error", text: r.message });
  }, []);
  useLoad(load);
  async function decide(s: Submission, decision: "APPROVE" | "REJECT" | "MERGE") {
    const r = await api<{ status: string }>("/api/admin/puja/submissions", {
      method: "POST",
      body: JSON.stringify({ kind: s.kind, id: s.id, decision, reason: reason[s.id] || null, mergeIntoId: target[s.id] || null }),
    });
    if (!r.ok) return setMessage({ tone: "error", text: r.message });
    setMessage({ tone: "ok", text: `“${s.name}” ${r.data.status.toLowerCase()}; the shop owner is notified.` });
    await load();
  }
  if (!rows) return <p className="text-sm text-ink-700">Loading…</p>;
  return (
    <div className="space-y-2" data-testid="puja-admin-review">
      <p className="text-sm text-ink-800">Product types and products shop owners created. Approve adds them to the master for every puja shop; reject or merge keeps them only in that shop. A reason is needed to reject or merge.</p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {rows.length === 0 ? <p className="text-sm text-ink-600">Nothing waiting.</p> : null}
      <ul className="space-y-2">
        {rows.map((s) => (
          <li key={`${s.kind}:${s.id}`} className="space-y-2 rounded-xl border border-cream-200 bg-white p-3 text-sm" data-testid="puja-submission">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <span className="mr-1 rounded bg-cream-100 px-1 text-xs font-semibold">{s.kind === "TYPE" ? "Product type" : "Product"}</span>
                <b>{s.name}</b> <span className="text-xs text-ink-600">{[s.nameHi, s.nameMr].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="text-xs text-ink-600">
                {s.shopName ?? "—"} · {s.createdByName ?? ""} · {formatIst(s.createdAt)}
              </span>
            </div>
            <p className="text-xs text-ink-700">
              {s.categoryName}
              {s.typeName ? ` · ${s.typeName}` : ""} · {s.detail}
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <input placeholder="Reason (needed to reject or merge)" value={reason[s.id] ?? ""} onChange={(e) => setReason({ ...reason, [s.id]: e.target.value })} className={input} />
              <select value={target[s.id] ?? ""} onChange={(e) => setTarget({ ...target, [s.id]: e.target.value })} className={input} aria-label="Merge into">
                <option value="">Merge into… (close matches)</option>
                {s.mergeCandidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <button type="button" className={primary} onClick={() => decide(s, "APPROVE")} data-testid="puja-approve">
                  Approve
                </button>
                <button type="button" className={danger} onClick={() => decide(s, "REJECT")} disabled={!reason[s.id]} data-testid="puja-reject">
                  Reject
                </button>
                <button type="button" className={secondary} onClick={() => decide(s, "MERGE")} disabled={!reason[s.id] || !target[s.id]} data-testid="puja-merge">
                  Merge
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------- festivals */

function FestivalsTab() {
  const blank = { id: "", festivalKey: "diwali", title: "", titleHi: "", titleMr: "", subtitle: "", startsAt: "", endsAt: "", active: true, showOnHome: true };
  const [rows, setRows] = useState<Festival[] | null>(null);
  const [form, setForm] = useState(blank);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ collections: Festival[] }>("/api/admin/puja/festivals");
    if (r.ok) setRows(r.data.collections);
  }, []);
  useLoad(load);
  async function save() {
    const body = {
      festivalKey: form.festivalKey,
      title: form.title,
      titleHi: form.titleHi || null,
      titleMr: form.titleMr || null,
      subtitle: form.subtitle || null,
      startsAt: istInputToDate(form.startsAt).toISOString(),
      endsAt: istInputToDate(form.endsAt).toISOString(),
      active: form.active,
      showOnHome: form.showOnHome,
    };
    const r = await api(form.id ? `/api/admin/puja/festivals/${form.id}` : "/api/admin/puja/festivals", { method: form.id ? "PATCH" : "POST", body: JSON.stringify(body) });
    if (!r.ok) return setMessage({ tone: "error", text: r.message });
    setMessage({ tone: "ok", text: "Saved. Times are IST." });
    setForm(blank);
    await load();
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2" data-testid="puja-admin-festivals">
      <section className="space-y-2 rounded-xl border border-cream-200 bg-white p-3">
        <h2 className="text-base font-bold">{form.id ? "Edit collection" : "New festival collection"}</h2>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-medium">
            Festival
            <select value={form.festivalKey} onChange={(e) => setForm({ ...form, festivalKey: e.target.value })} className={input}>
              {PUJA_FESTIVALS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.en}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium">
            Title
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={input} placeholder="Diwali puja kits" />
          </label>
          <label className="text-xs font-medium">
            Title हिंदी
            <input value={form.titleHi} onChange={(e) => setForm({ ...form, titleHi: e.target.value })} className={input} />
          </label>
          <label className="text-xs font-medium">
            Title मराठी
            <input value={form.titleMr} onChange={(e) => setForm({ ...form, titleMr: e.target.value })} className={input} />
          </label>
          <label className="col-span-2 text-xs font-medium">
            Subtitle
            <input value={form.subtitle} onChange={(e) => setForm({ ...form, subtitle: e.target.value })} className={input} />
          </label>
          <label className="text-xs font-medium">
            Starts (IST)
            <input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} className={input} />
          </label>
          <label className="text-xs font-medium">
            Ends (IST)
            <input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} className={input} />
          </label>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <label className="flex min-h-10 items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> On
          </label>
          <label className="flex min-h-10 items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={form.showOnHome} onChange={(e) => setForm({ ...form, showOnHome: e.target.checked })} /> Also a home-page banner
          </label>
        </div>
        <button type="button" className={primary} onClick={save} disabled={!form.title || !form.startsAt || !form.endsAt} data-testid="puja-festival-save">
          Save
        </button>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      </section>
      <section className="space-y-2">
        {(rows ?? []).map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 rounded-xl border border-cream-200 bg-white p-2 text-sm">
            <span>
              <b>{c.title}</b> <span className="text-xs text-ink-600">{c.festivalKey}</span>
              <span className="block text-xs text-ink-700">
                {formatIst(c.startsAt)} → {formatIst(c.endsAt)} · {c.active ? "on" : "off"}
                {c.homeBannerId ? " · home banner" : ""}
              </span>
            </span>
            <button
              type="button"
              className="text-xs font-semibold text-kesari-800 underline"
              onClick={() =>
                setForm({
                  id: c.id,
                  festivalKey: c.festivalKey,
                  title: c.title,
                  titleHi: c.titleHi ?? "",
                  titleMr: c.titleMr ?? "",
                  subtitle: c.subtitle ?? "",
                  startsAt: dateToIstInput(c.startsAt),
                  endsAt: dateToIstInput(c.endsAt),
                  active: c.active,
                  showOnHome: Boolean(c.homeBannerId),
                })
              }
            >
              Edit
            </button>
          </div>
        ))}
        {rows && rows.length === 0 ? <p className="text-sm text-ink-600">No collections yet.</p> : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------- config */

function ConfigTab() {
  const [config, setConfig] = useState<Config | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const load = useCallback(async () => {
    const r = await api<Config>("/api/admin/puja/config");
    if (r.ok) setConfig(r.data);
    else setMessage({ tone: "error", text: r.message });
  }, []);
  useLoad(load);
  async function patch(body: Record<string, unknown>) {
    const r = await api<Config>("/api/admin/puja/config", { method: "PATCH", body: JSON.stringify(body) });
    if (!r.ok) return setMessage({ tone: "error", text: r.message });
    setConfig(r.data);
    setMessage({ tone: "ok", text: "Saved." });
  }
  if (!config) return <p className="text-sm text-ink-700">Loading…</p>;
  return (
    <div className="grid gap-3 lg:grid-cols-2" data-testid="puja-admin-config">
      <section className="space-y-3 rounded-xl border border-cream-200 bg-white p-3 text-sm">
        <label className="flex min-h-10 items-center justify-between gap-2">
          <span>
            <b>{config.label}</b> shop type
            <span className="block text-xs text-ink-700">Off: not offered at registration; shops cannot take the catalogue.</span>
          </span>
          <input type="checkbox" className="h-5 w-5" checked={config.enabled} onChange={(e) => patch({ enabled: e.target.checked })} data-testid="puja-config-enabled" />
        </label>
        <label className="flex min-h-10 items-center justify-between gap-2">
          <span>
            <b>FSSAI for edible items</b>
            <span className="block text-xs text-ink-700">On: a shop listing prasad and dry items (category 10), edible kits or bulk ghee / mishri needs an FSSAI licence. Off: never for puja lines.</span>
          </span>
          <input type="checkbox" className="h-5 w-5" checked={config.edibleNeedsFssai} onChange={(e) => patch({ edibleNeedsFssai: e.target.checked })} data-testid="puja-config-fssai" />
        </label>
        <label className="flex min-h-10 items-center justify-between gap-2">
          <span>
            <b>Stock per product</b> when a shop takes the catalogue
          </span>
          <input
            type="number"
            min={0}
            max={100000}
            defaultValue={config.seedDefaultStock}
            onBlur={(e) => Number(e.target.value) !== config.seedDefaultStock && patch({ seedDefaultStock: Number(e.target.value) })}
            className="min-h-10 w-24 rounded-lg border border-cream-200 px-2"
          />
        </label>
        <p className="text-xs text-ink-700">
          Registration fee: the standard shop fee (Admin → Registration fees). Documents: GST or PAN as for every shop; FSSAI only as above.
        </p>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      </section>
      <section className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        {[
          ["Products", config.counts.products],
          ["Categories", config.counts.categories],
          ["Product types", config.counts.types],
          ["Puja shops", config.counts.shops],
          ["HSN/GST to verify", config.counts.taxToVerify],
          ["Edible lines", config.counts.edible],
        ].map(([label, n]) => (
          <div key={label as string} className="rounded-xl border border-cream-200 bg-white p-3">
            <p className="text-2xl font-bold tabular-nums">{n}</p>
            <p className="text-xs text-ink-700">{label}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
