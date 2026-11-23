"use client";

/**
 * RBAC v2 Phases 4, 5 and 7 — staff support screens (docs/rbac/04-support-and-change-requests.md):
 * raise a ticket about a shop, the Support Manager's queue controls, the Support User's shop workbench (propose
 * changes, bulk price list), and the Operations User's confirmation of resolved handover tickets. The server
 * decides every permission; this only shows the controls.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
    throw new Error((fields ? Object.values(fields).join(" ") : null) ?? payload?.error?.message ?? "That did not work.");
  }
  return payload;
}

type Msg = { tone: "success" | "danger"; text: string } | null;

/* ------------------------------------------------------------ raise ticket */

export function RaiseTicketForm({ categories, shops, opsTaskId, defaultShopId }: { categories: { key: string; label: string }[]; shops: { id: string; name: string }[]; opsTaskId?: string | null; defaultShopId?: string | null }) {
  const router = useRouter();
  const [shopId, setShopId] = useState(defaultShopId ?? shops[0]?.id ?? "");
  const [category, setCategory] = useState(categories[0]?.key ?? "OTHER");
  const [priority, setPriority] = useState("NORMAL");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  async function submit() {
    try {
      const t = await call("/api/staff/support/tickets", "POST", { shopId, category, priority, subject, description, opsTaskId: opsTaskId ?? null });
      setMsg({ tone: "success", text: `Ticket ${t.ticketNumber} raised. It is in the Support Manager's queue.` });
      setSubject("");
      setDescription("");
      router.refresh();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    }
  }
  return (
    <Card>
      <p className="mb-2 font-semibold">Raise a ticket to Support</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {shops.length ? (
          <select className={inputClass} value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Shop">
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <input className={inputClass} placeholder="Shop ID" value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Shop ID" />
        )}
        <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          {categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <select className={inputClass} value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
          {["LOW", "NORMAL", "HIGH", "URGENT"].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <input className={`${inputClass} mt-2`} placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
      <textarea className={`${inputClass} mt-2 min-h-24`} placeholder="What is needed (product list, correction, documents…)" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" />
      <div className="mt-2 flex justify-end">
        <Button size="sm" disabled={!shopId || subject.trim().length < 3 || description.trim().length < 10} onClick={submit}>
          Raise ticket
        </Button>
      </div>
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
    </Card>
  );
}

/* ---------------------------------------------------------- ticket lists */

export interface DeskRow {
  id: string;
  ticketNumber: string;
  subject: string;
  briefStatus: string;
  status: string;
  priority: string;
  shopId: string | null;
  shopName: string | null;
  dueIst: string;
  overdue: boolean;
  assigneeId: string | null;
}

export function DeskTicketList({
  rows,
  mode,
  team = [],
}: {
  rows: DeskRow[];
  mode: "mine" | "raised" | "manager";
  team?: { userId: string; name: string }[];
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<Record<string, string>>({});
  async function act(id: string, url: string, method: string, body: unknown) {
    try {
      await call(url, method, body);
      setMsg((m) => ({ ...m, [id]: "Saved." }));
      router.refresh();
    } catch (e) {
      setMsg((m) => ({ ...m, [id]: e instanceof Error ? e.message : "That did not work." }));
    }
  }
  if (rows.length === 0) return <EmptyState title="No tickets here" />;
  return (
    <div className="grid gap-2">
      {rows.map((r) => (
        <Card key={r.id}>
          <div className="flex flex-wrap items-center gap-2">
            <a className="font-semibold text-kesari-800 hover:underline" href={`/admin/support/${r.id}`}>
              {r.ticketNumber}
            </a>
            <Badge tone={r.overdue ? "danger" : r.status === "RESOLVED" ? "success" : "info"}>{r.briefStatus}</Badge>
            <Badge tone={r.priority === "URGENT" || r.priority === "HIGH" ? "warning" : "neutral"}>{r.priority}</Badge>
            <span className="text-sm text-ink-600">
              {r.shopName ?? "—"} · due {r.dueIst} IST
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-800">{r.subject}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {mode === "mine" && r.shopId ? (
              <a className="inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline" href={`/staff/support/shop/${r.shopId}?ticket=${r.id}`}>
                Open shop workbench →
              </a>
            ) : null}
            {mode === "raised" && r.status === "RESOLVED" ? (
              <Button size="sm" onClick={() => act(r.id, `/api/staff/support/tickets/${r.id}/confirm`, "POST", {})}>
                Confirm and close
              </Button>
            ) : null}
            {mode === "manager" ? (
              <>
                <select
                  className={inputClass}
                  defaultValue={r.assigneeId ?? ""}
                  onChange={(e) => act(r.id, `/api/staff/support/tickets/${r.id}`, "PATCH", { assigneeId: e.target.value || null })}
                  aria-label={`Assign ${r.ticketNumber}`}
                >
                  <option value="">Unassigned</option>
                  {team.map((t) => (
                    <option key={t.userId} value={t.userId}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <select className={inputClass} defaultValue={r.priority} onChange={(e) => act(r.id, `/api/staff/support/tickets/${r.id}`, "PATCH", { priority: e.target.value })} aria-label={`Priority of ${r.ticketNumber}`}>
                  {["LOW", "NORMAL", "HIGH", "URGENT"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
                <select className={inputClass} defaultValue="" onChange={(e) => act(r.id, `/api/staff/support/tickets/${r.id}`, "PATCH", { subStatus: e.target.value || null })} aria-label={`Side status of ${r.ticketNumber}`}>
                  <option value="">No side status</option>
                  <option value="PENDING_INFORMATION">Pending Information</option>
                  <option value="ON_HOLD">On Hold</option>
                  <option value="REJECTED">Rejected</option>
                </select>
                {r.status === "RESOLVED" ? (
                  <Button size="sm" variant="secondary" onClick={() => act(r.id, `/api/staff/support/tickets/${r.id}/confirm`, "POST", {})}>
                    Confirm and close
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
          {msg[r.id] ? <p className="mt-1 text-sm text-ink-600">{msg[r.id]}</p> : null}
        </Card>
      ))}
    </div>
  );
}

/* --------------------------------------------------------- shop workbench */

export interface WorkbenchProduct {
  shopProductId: string;
  name: string;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  mrpPaise: number | null;
  isAvailable: boolean;
}
export interface WorkbenchShopField {
  field: string;
  label: string;
  value: string;
}

const rupees = (p: number | null) => (p == null ? "" : (p / 100).toFixed(2));
const paise = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));

export function ShopWorkbench({ shopId, ticketId, shopFields, products }: { shopId: string; ticketId: string | null; shopFields: WorkbenchShopField[]; products: WorkbenchProduct[] }) {
  const router = useRouter();
  const [shopDraft, setShopDraft] = useState<Record<string, string>>(Object.fromEntries(shopFields.map((f) => [f.field, f.value])));
  const [prodDraft, setProdDraft] = useState<Record<string, { online: string; offline: string; mrp: string; available: boolean }>>(
    Object.fromEntries(products.map((p) => [p.shopProductId, { online: rupees(p.onlinePricePaise), offline: rupees(p.offlinePricePaise), mrp: rupees(p.mrpPaise), available: p.isAvailable }])),
  );
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [bulkMsg, setBulkMsg] = useState<{ tone: "success" | "danger"; text: string; report?: string } | null>(null);

  async function send() {
    const items: unknown[] = [];
    for (const f of shopFields) if ((shopDraft[f.field] ?? "") !== f.value) items.push({ target: "SHOP", field: f.field, value: shopDraft[f.field] || null });
    for (const p of products) {
      const d = prodDraft[p.shopProductId];
      if (paise(d.online) !== p.onlinePricePaise && d.online !== "") items.push({ target: "SHOP_PRODUCT", shopProductId: p.shopProductId, field: "onlinePricePaise", value: paise(d.online) });
      if (paise(d.offline) !== p.offlinePricePaise && d.offline !== "") items.push({ target: "SHOP_PRODUCT", shopProductId: p.shopProductId, field: "offlinePricePaise", value: paise(d.offline) });
      if (paise(d.mrp) !== p.mrpPaise && d.mrp !== "") items.push({ target: "SHOP_PRODUCT", shopProductId: p.shopProductId, field: "shopMrpPaise", value: paise(d.mrp) });
      if (d.available !== p.isAvailable) items.push({ target: "SHOP_PRODUCT", shopProductId: p.shopProductId, field: "isAvailable", value: d.available });
    }
    if (items.length === 0) {
      setMsg({ tone: "danger", text: "Nothing changed." });
      return;
    }
    try {
      const r = await call(`/api/staff/shops/${shopId}/changes`, "POST", { ticketId, reason, items });
      setMsg({ tone: "success", text: `${r.title} sent to the shop owner. Nothing changes until they approve.` });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    }
  }

  async function upload(file: File) {
    const form = new FormData();
    form.set("file", file);
    form.set("reason", reason || "Price list from the shop owner");
    if (ticketId) form.set("ticketId", ticketId);
    try {
      const res = await fetch(`/api/staff/shops/${shopId}/changes/bulk`, { method: "POST", body: form });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setBulkMsg({
        tone: payload.errors.length ? "danger" : "success",
        text: `${payload.rows} rows read: ${payload.changes} change(s) sent to the owner in one request; ${payload.errors.length} row(s) with problems.`,
        report: payload.errorReport ?? undefined,
      });
      router.refresh();
    } catch (e) {
      setBulkMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    }
  }

  return (
    <div className="grid gap-3">
      <Card>
        <p className="mb-2 font-semibold">Shop details</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {shopFields.map((f) => (
            <label key={f.field} className="grid gap-1 text-sm">
              <span className="text-ink-600">{f.label}</span>
              <input className={inputClass} value={shopDraft[f.field] ?? ""} onChange={(e) => setShopDraft((d) => ({ ...d, [f.field]: e.target.value }))} />
            </label>
          ))}
        </div>
      </Card>
      <Card>
        <p className="mb-2 font-semibold">Products (selling price ≤ MRP; MRP here is this shop&apos;s only)</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-600">
                <th className="py-1">Product</th>
                <th className="py-1">Online ₹</th>
                <th className="py-1">In shop ₹</th>
                <th className="py-1">MRP ₹</th>
                <th className="py-1">Available</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const d = prodDraft[p.shopProductId];
                const set = (k: "online" | "offline" | "mrp", v: string) => setProdDraft((all) => ({ ...all, [p.shopProductId]: { ...all[p.shopProductId], [k]: v } }));
                return (
                  <tr key={p.shopProductId} className="border-t border-cream-200">
                    <td className="py-1 pr-2">{p.name}</td>
                    <td className="py-1 pr-1">
                      <input className={inputClass} inputMode="decimal" value={d.online} onChange={(e) => set("online", e.target.value)} aria-label={`${p.name} online price`} />
                    </td>
                    <td className="py-1 pr-1">
                      <input className={inputClass} inputMode="decimal" value={d.offline} onChange={(e) => set("offline", e.target.value)} aria-label={`${p.name} in-shop price`} />
                    </td>
                    <td className="py-1 pr-1">
                      <input className={inputClass} inputMode="decimal" value={d.mrp} onChange={(e) => set("mrp", e.target.value)} aria-label={`${p.name} MRP`} />
                    </td>
                    <td className="py-1">
                      <input
                        type="checkbox"
                        checked={d.available}
                        onChange={(e) => setProdDraft((all) => ({ ...all, [p.shopProductId]: { ...all[p.shopProductId], available: e.target.checked } }))}
                        aria-label={`${p.name} available`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <input className={inputClass} placeholder="Reason the owner will see (required)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          <Button size="sm" disabled={reason.trim().length < 3} onClick={send}>
            Send to the shop owner
          </Button>
        </div>
        {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
      </Card>
      <Card>
        <p className="mb-2 font-semibold">Bulk price list</p>
        <div className="flex flex-wrap items-center gap-2">
          <a className="inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline" href={`/api/staff/shops/${shopId}/changes/template`}>
            Download this shop&apos;s template (CSV)
          </a>
          <input type="file" accept=".csv,.xlsx" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} aria-label="Upload the edited price list" />
        </div>
        {bulkMsg ? (
          <Alert tone={bulkMsg.tone}>
            {bulkMsg.text}{" "}
            {bulkMsg.report ? (
              <a className="underline" download="price-list-errors.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(bulkMsg.report)}`}>
                Download the error report
              </a>
            ) : null}
          </Alert>
        ) : null}
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- documents */

export interface DocRow {
  id: string;
  title: string;
  docType: string;
  verificationStatus: string;
  currentVersion: number;
  versions: { version: number; filename: string; uploadedAtIst: string }[];
}

export function DocumentsPanel({ shopId, ticketId, docs, types, canVerify }: { shopId: string; ticketId: string | null; docs: DocRow[]; types: string[]; canVerify: boolean }) {
  const router = useRouter();
  const [docType, setDocType] = useState(types[0] ?? "OTHER");
  const [title, setTitle] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  async function upload(file: File, documentId?: string) {
    const form = new FormData();
    form.set("file", file);
    form.set("shopId", shopId);
    form.set("docType", docType);
    form.set("title", title || file.name);
    if (documentId) form.set("documentId", documentId);
    if (ticketId) form.set("ticketId", ticketId);
    try {
      const res = await fetch("/api/staff/documents", { method: "POST", body: form });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setMsg({ tone: "success", text: `Saved as version ${payload.version}.` });
      setTitle("");
      router.refresh();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    }
  }
  async function open(id: string, version: number) {
    try {
      const link = await call(`/api/staff/documents/${id}/link?version=${version}`, "GET");
      window.location.assign(link.url);
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    }
  }
  async function verify(id: string, status: "VERIFIED" | "REJECTED") {
    try {
      await call(`/api/staff/documents/${id}/verify`, "POST", { status });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : "That did not work." });
    }
  }
  return (
    <Card>
      <p className="mb-2 font-semibold">Documents</p>
      <div className="flex flex-wrap items-center gap-2">
        <select className={inputClass} value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="Document type">
          {types.map((t) => (
            <option key={t} value={t}>
              {t.replace(/_/g, " ").toLowerCase()}
            </option>
          ))}
        </select>
        <input className={inputClass} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Document title" />
        <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.csv,.xlsx" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} aria-label="Upload a document" />
      </div>
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
      {docs.length === 0 ? <p className="mt-2 text-sm text-ink-600">No documents yet.</p> : null}
      <div className="mt-2 grid gap-2">
        {docs.map((d) => (
          <div key={d.id} className="rounded-lg border border-cream-200 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{d.title}</span>
              <Badge tone="neutral">{d.docType.replace(/_/g, " ").toLowerCase()}</Badge>
              <Badge tone={d.verificationStatus === "VERIFIED" ? "success" : d.verificationStatus === "REJECTED" ? "danger" : "warning"}>{d.verificationStatus}</Badge>
              <span className="flex-1" />
              <label className="text-sm text-kesari-800">
                New version <input type="file" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0], d.id)} />
              </label>
              {canVerify ? (
                <>
                  <Button size="sm" variant="secondary" onClick={() => verify(d.id, "VERIFIED")}>
                    Verify
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => verify(d.id, "REJECTED")}>
                    Reject
                  </Button>
                </>
              ) : null}
            </div>
            <ul className="mt-1 text-sm text-ink-700">
              {d.versions.map((v) => (
                <li key={v.version}>
                  <button type="button" className="min-h-11 text-left text-kesari-800 underline" onClick={() => open(d.id, v.version)}>
                    v{v.version} · {v.filename}
                  </button>{" "}
                  · {v.uploadedAtIst} IST
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}
