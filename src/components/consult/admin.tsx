"use client";

/**
 * Consultant appointments for staff (docs/consult-booking-2026-11): profile
 * and certificate verification, every booking with filters (refunds,
 * disputes), categories with commission and required registration,
 * cancellation policy templates, and reports.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { CONSULT_BOOKING_STATUSES, CONSULT_MODES, CONSULT_REQUIRED_DOC_LABELS, CONSULT_REQUIRED_DOCS, CONSULT_STATUS_LABELS } from "@/lib/consult/constants";
import { formatIst, formatSlot } from "@/lib/consult/time";
import { Alert, Badge, Button, Field, inputClass } from "@/components/ui";
import { ConsultBookingView } from "./booking-view";
import { api, Chip, modeLabel, Panel, rupees, StatusPill, Tile } from "./common";

type Tab = "verify" | "bookings" | "categories" | "policies" | "reports";

export function ConsultAdmin({ initialTab = "verify" }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const post = async (body: Record<string, unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await api("/api/admin/consult", { json: body });
      setNotice(done);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not save.");
      return false;
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="consult-admin">
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {(
          [
            ["verify", "Verification"],
            ["bookings", "Bookings"],
            ["categories", "Categories"],
            ["policies", "Policies"],
            ["reports", "Reports"],
          ] as const
        ).map(([k, l]) => (
          <Chip key={k} active={tab === k} onClick={() => setTab(k)} testId={`consult-admin-tab-${k}`}>
            {l}
          </Chip>
        ))}
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {tab === "verify" ? <Verify post={post} /> : null}
      {tab === "bookings" ? <Bookings post={post} /> : null}
      {tab === "categories" ? <Categories post={post} /> : null}
      {tab === "policies" ? <Policies post={post} /> : null}
      {tab === "reports" ? <Reports /> : null}
    </div>
  );
}

type Post = (body: Record<string, unknown>, done: string) => Promise<boolean>;

interface ProfileRow {
  id: string;
  shopId: string;
  slug: string;
  name: string;
  shopName: string;
  shopStatus: string;
  city: string;
  status: string;
  verification: string;
  verificationNote: string | null;
  members: { id: string; name: string; docStatus: string; registrationNumber: string | null; registrationBody: string | null; documents: { id: string; fileName: string; createdAt: string }[] }[];
  bookings30d: number;
}

function Verify({ post }: { post: Post }) {
  const [filter, setFilter] = useState("PENDING");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ProfileRow[]>([]);
  const [docs, setDocs] = useState<Record<string, { id: string; fileName: string; url: string }[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: "profiles" });
    if (filter) p.set("verification", filter);
    if (q) p.set("q", q);
    setRows((await api<{ profiles: ProfileRow[] }>(`/api/admin/consult?${p.toString()}`)).profiles);
  }, [filter, q]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the view's inputs change
    void load();
  }, [load]);
  const openDocs = async (memberId: string) => setDocs({ ...docs, [memberId]: (await api<{ documents: { id: string; fileName: string; url: string }[] }>(`/api/admin/consult?view=documents&member=${memberId}`)).documents });
  const decide = async (r: ProfileRow, decision: string, memberDecision?: "VERIFIED" | "REJECTED") => {
    const members = memberDecision ? r.members.filter((m) => m.docStatus === "SUBMITTED" || m.docStatus === "REJECTED" || m.docStatus === "VERIFIED").map((m) => ({ id: m.id, decision: memberDecision, note: notes[r.id] || null })) : [];
    if (await post({ action: "verify", profileId: r.id, decision, note: notes[r.id] || null, members }, `${r.name}: ${decision.toLowerCase()}.`)) await load();
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {["PENDING", "VERIFIED", "REJECTED", ""].map((f) => (
          <Chip key={f || "all"} active={filter === f} onClick={() => setFilter(f)}>
            {f || "All"}
          </Chip>
        ))}
        <input className={`${inputClass} max-w-xs`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or city" aria-label="Search" />
      </div>
      {rows.length === 0 ? <p className="text-sm text-ink-600">Nothing here.</p> : null}
      {rows.map((r) => (
        <div key={r.id} className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3" data-testid="consult-admin-profile">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-extrabold">
                <Link href={`/consult/${encodeURIComponent(r.slug)}`} className="hover:underline">
                  {r.name}
                </Link>{" "}
                <span className="text-sm font-normal text-ink-600">
                  ({r.shopName}, {r.city})
                </span>
              </p>
              <p className="text-xs">
                Profile <Badge>{r.status}</Badge> Verification <Badge tone={r.verification === "VERIFIED" ? "success" : r.verification === "REJECTED" ? "danger" : "info"}>{r.verification}</Badge> Shop <Badge>{r.shopStatus}</Badge> · {r.bookings30d} bookings in 30 days
              </p>
            </div>
            <Link href={`/shop/consult/setup?shopId=${r.shopId}`} className="text-sm font-bold text-kesari-800 underline">
              Open setup
            </Link>
          </div>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {r.members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <strong>{m.name}</strong> <Badge tone={m.docStatus === "VERIFIED" ? "success" : m.docStatus === "SUBMITTED" ? "info" : m.docStatus === "NOT_REQUIRED" ? "neutral" : "warning"}>{m.docStatus}</Badge>
                {m.registrationNumber ? `${m.registrationBody ?? ""} No. ${m.registrationNumber}` : ""}
                {m.documents.length ? (
                  <button type="button" className="font-bold text-kesari-800 underline" onClick={() => openDocs(m.id)}>
                    {m.documents.length} certificate(s)
                  </button>
                ) : null}
                {(docs[m.id] ?? []).map((d) => (
                  <a key={d.id} href={d.url} target="_blank" rel="noreferrer" className="text-xs text-kesari-800 underline">
                    {d.fileName}
                  </a>
                ))}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input className={`${inputClass} max-w-sm`} placeholder="Note to the consultant" value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
            <Button size="sm" onClick={() => decide(r, "VERIFIED", "VERIFIED")} data-testid="consult-verify">
              Verify
            </Button>
            <Button size="sm" variant="secondary" onClick={() => decide(r, "REJECTED", "REJECTED")}>
              Reject
            </Button>
            {r.status === "BLOCKED" ? (
              <Button size="sm" variant="secondary" onClick={() => decide(r, "UNBLOCK")}>
                Unblock
              </Button>
            ) : (
              <Button size="sm" variant="danger" onClick={() => decide(r, "BLOCK")}>
                Block
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface Card {
  id: string;
  bookingNumber: string;
  status: string;
  rescheduleCount: number;
  startsAt: string;
  mode: string;
  serviceName: string;
  visitorName: string;
  firmName: string;
  feePaise: number;
  paidOnlinePaise: number;
  paidOfflinePaise: number;
  refundPaise: number;
}

function Bookings({ post }: { post: Post }) {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [refunds, setRefunds] = useState(false);
  const [disputes, setDisputes] = useState(false);
  const [rows, setRows] = useState<Card[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: "bookings" });
    if (status) p.set("status", status);
    if (q) p.set("q", q);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (refunds) p.set("refunds", "true");
    if (disputes) p.set("disputes", "true");
    setRows((await api<{ bookings: Card[] }>(`/api/admin/consult?${p.toString()}`)).bookings);
  }, [status, q, from, to, refunds, disputes]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the view's inputs change
    void load();
  }, [load]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {CONSULT_BOOKING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CONSULT_STATUS_LABELS[s].en}
            </option>
          ))}
        </select>
        <input className={`${inputClass} w-40`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input className={`${inputClass} w-40`} type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <input className={`${inputClass} w-48`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Booking no., visitor, service" aria-label="Search" />
        <Chip active={refunds} onClick={() => setRefunds(!refunds)}>
          With refunds
        </Chip>
        <Chip active={disputes} onClick={() => setDisputes(!disputes)}>
          Disputed
        </Chip>
      </div>
      <div className="overflow-x-auto rounded-2xl border-2 border-[var(--gk-line)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-cream-50 text-left text-xs text-ink-600">
            <tr>
              <th className="p-2">Booking</th>
              <th className="p-2">When (IST)</th>
              <th className="p-2">Consultant</th>
              <th className="p-2">Visitor</th>
              <th className="p-2">Status</th>
              <th className="p-2 text-right">Fee</th>
              <th className="p-2 text-right">Paid</th>
              <th className="p-2 text-right">Refund</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} className="border-t border-cream-100">
                <td className="p-2 font-mono text-xs">{b.bookingNumber}</td>
                <td className="p-2">{formatSlot(b.startsAt)}</td>
                <td className="p-2">{b.firmName}</td>
                <td className="p-2">
                  {b.visitorName}
                  <span className="block text-xs text-ink-500">
                    {b.serviceName} · {modeLabel(b.mode)}
                  </span>
                </td>
                <td className="p-2">
                  <StatusPill status={b.status} rescheduled={b.rescheduleCount > 0} />
                </td>
                <td className="p-2 text-right">{rupees(b.feePaise)}</td>
                <td className="p-2 text-right">{rupees(b.paidOnlinePaise + b.paidOfflinePaise)}</td>
                <td className="p-2 text-right">{b.refundPaise ? rupees(b.refundPaise) : "—"}</td>
                <td className="p-2">
                  <Button size="sm" variant="secondary" onClick={() => setOpen(b.id)}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="p-3 text-sm text-ink-600">No bookings match.</p> : null}
      </div>
      {open ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true" onClick={() => setOpen(null)}>
          <div className="h-full w-full max-w-xl overflow-y-auto bg-cream-50 p-3" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex justify-between">
              <Button
                variant="danger"
                size="sm"
                onClick={async () => {
                  const reason = window.prompt("Reason for cancelling (sent to both sides). The customer is refunded in full.");
                  if (reason && (await post({ action: "cancel", bookingId: open, reason }, "Cancelled by GoKesari; full refund requested."))) await load();
                }}
              >
                Cancel with full refund
              </Button>
              <Button variant="ghost" onClick={() => setOpen(null)}>
                Close ✕
              </Button>
            </div>
            <ConsultBookingView bookingId={open} onChanged={load} compact />
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface Category {
  id: string;
  name: string;
  groupName: string;
  description: string | null;
  requiredDoc: string;
  requiredDocLabel: string | null;
  defaultModes: string[];
  commissionBp: number | null;
  sacCode: string | null;
  sensitive: boolean;
  status: string;
  sortOrder: number;
  consultants: number;
}

function Categories({ post }: { post: Post }) {
  const [rows, setRows] = useState<Category[]>([]);
  const [edit, setEdit] = useState<Partial<Category> & { commissionPct?: string } | null>(null);
  const load = useCallback(async () => setRows((await api<{ categories: Category[] }>("/api/admin/consult?view=categories")).categories), []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the view's inputs change
    void load();
  }, [load]);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button onClick={() => setEdit({ name: "", groupName: "Other services", requiredDoc: "NONE", defaultModes: ["IN_PERSON"], status: "ACTIVE", sortOrder: 100, sensitive: false, commissionPct: "" })} data-testid="consult-add-category">
          + Add category
        </Button>
      </div>
      {edit ? (
        <Panel title={edit.id ? `Edit ${edit.name}` : "New category"}>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Name">
              <input className={inputClass} value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} data-testid="consult-category-name" />
            </Field>
            <Field label="Group">
              <input className={inputClass} value={edit.groupName ?? ""} onChange={(e) => setEdit({ ...edit, groupName: e.target.value })} />
            </Field>
            <Field label="GoKesari commission (%)" hint="Blank: the platform default (2%)">
              <input className={inputClass} inputMode="decimal" value={edit.commissionPct ?? ""} onChange={(e) => setEdit({ ...edit, commissionPct: e.target.value })} data-testid="consult-category-commission" />
            </Field>
            <Field label="Registration each consultant must upload">
              <select className={inputClass} value={edit.requiredDoc} onChange={(e) => setEdit({ ...edit, requiredDoc: e.target.value })}>
                {CONSULT_REQUIRED_DOCS.map((d) => (
                  <option key={d} value={d}>
                    {CONSULT_REQUIRED_DOC_LABELS[d]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Document wording">
              <input className={inputClass} value={edit.requiredDocLabel ?? ""} onChange={(e) => setEdit({ ...edit, requiredDocLabel: e.target.value })} />
            </Field>
            <Field label="SAC code (tax invoices)">
              <input className={inputClass} value={edit.sacCode ?? ""} onChange={(e) => setEdit({ ...edit, sacCode: e.target.value })} />
            </Field>
            <div className="sm:col-span-3 flex flex-wrap gap-1.5">
              {CONSULT_MODES.map((m) => (
                <Chip key={m} active={edit.defaultModes?.includes(m)} onClick={() => setEdit({ ...edit, defaultModes: edit.defaultModes?.includes(m) ? edit.defaultModes.filter((x) => x !== m) : [...(edit.defaultModes ?? []), m] })}>
                  {modeLabel(m)}
                </Chip>
              ))}
              <label className="ml-2 flex items-center gap-1 text-sm">
                <input type="checkbox" checked={Boolean(edit.sensitive)} onChange={(e) => setEdit({ ...edit, sensitive: e.target.checked })} /> Medical / legal (log every look)
              </label>
              <label className="ml-2 flex items-center gap-1 text-sm">
                <input type="checkbox" checked={edit.status !== "INACTIVE"} onChange={(e) => setEdit({ ...edit, status: e.target.checked ? "ACTIVE" : "INACTIVE" })} /> Active
              </label>
            </div>
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              data-testid="consult-save-category"
              onClick={async () => {
                const ok = await post(
                  {
                    action: "category",
                    category: {
                      id: edit.id,
                      name: edit.name,
                      groupName: edit.groupName,
                      description: edit.description,
                      requiredDoc: edit.requiredDoc,
                      requiredDocLabel: edit.requiredDocLabel,
                      defaultModes: edit.defaultModes,
                      commissionPct: edit.commissionPct === "" || edit.commissionPct == null ? null : Number(edit.commissionPct),
                      sacCode: edit.sacCode ?? "",
                      sensitive: edit.sensitive,
                      status: edit.status,
                      sortOrder: edit.sortOrder,
                    },
                  },
                  "Category saved.",
                );
                if (ok) {
                  setEdit(null);
                  await load();
                }
              }}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
          </div>
        </Panel>
      ) : null}
      <div className="overflow-x-auto rounded-2xl border-2 border-[var(--gk-line)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-cream-50 text-left text-xs text-ink-600">
            <tr>
              <th className="p-2">Category</th>
              <th className="p-2">Group</th>
              <th className="p-2">Registration</th>
              <th className="p-2">Commission</th>
              <th className="p-2">SAC</th>
              <th className="p-2">Consultants</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={`border-t border-cream-100 ${c.status === "INACTIVE" ? "text-ink-400" : ""}`}>
                <td className="p-2 font-bold">
                  {c.name} {c.status === "INACTIVE" ? <Badge tone="warning">Off</Badge> : null}
                </td>
                <td className="p-2">{c.groupName}</td>
                <td className="p-2">{c.requiredDoc === "NONE" ? "—" : c.requiredDocLabel ?? c.requiredDoc}</td>
                <td className="p-2">{c.commissionBp == null ? "Default" : `${c.commissionBp / 100}%`}</td>
                <td className="p-2">{c.sacCode ?? "—"}</td>
                <td className="p-2">{c.consultants}</td>
                <td className="p-2">
                  <Button size="sm" variant="secondary" onClick={() => setEdit({ ...c, commissionPct: c.commissionBp == null ? "" : String(c.commissionBp / 100) })}>
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Template {
  id: string;
  name: string;
  description: string | null;
  freeCancelHours: number;
  lateCancelRefundPct: number;
  noShowRefundPct: number;
  rescheduleMinHours: number;
  maxReschedules: number;
  status: string;
  isDefault: boolean;
}

function Policies({ post }: { post: Post }) {
  const [rows, setRows] = useState<Template[]>([]);
  const [edit, setEdit] = useState<Partial<Template> | null>(null);
  const load = useCallback(async () => setRows((await api<{ templates: Template[] }>("/api/admin/consult?view=templates")).templates), []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the view's inputs change
    void load();
  }, [load]);
  const num = (k: keyof Template) => (
    <input className={inputClass} type="number" min={0} value={(edit?.[k] as number) ?? 0} onChange={(e) => setEdit({ ...edit, [k]: Number(e.target.value) })} />
  );
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button onClick={() => setEdit({ name: "", freeCancelHours: 24, lateCancelRefundPct: 50, noShowRefundPct: 0, rescheduleMinHours: 4, maxReschedules: 2, status: "ACTIVE", isDefault: false })}>+ Add policy</Button>
      </div>
      {edit ? (
        <Panel title={edit.id ? `Edit ${edit.name}` : "New policy"}>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Name">
              <input className={inputClass} value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="Description">
              <input className={inputClass} value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </Field>
            <Field label="Free cancellation (hours before)">{num("freeCancelHours")}</Field>
            <Field label="Late refund (%)">{num("lateCancelRefundPct")}</Field>
            <Field label="No-show refund (%)">{num("noShowRefundPct")}</Field>
            <Field label="Reschedule until (hours before)">{num("rescheduleMinHours")}</Field>
            <Field label="Reschedules allowed">{num("maxReschedules")}</Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={Boolean(edit.isDefault)} onChange={(e) => setEdit({ ...edit, isDefault: e.target.checked })} /> Default for new consultants
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={edit.status !== "INACTIVE"} onChange={(e) => setEdit({ ...edit, status: e.target.checked ? "ACTIVE" : "INACTIVE" })} /> Active
            </label>
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              onClick={async () => {
                if (await post({ action: "template", template: edit }, "Policy saved.")) {
                  setEdit(null);
                  await load();
                }
              }}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
          </div>
        </Panel>
      ) : null}
      <ul className="grid gap-2 sm:grid-cols-2">
        {rows.map((t) => (
          <li key={t.id} className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 text-sm">
            <p className="font-extrabold">
              {t.name} {t.isDefault ? <Badge tone="success">Default</Badge> : null} {t.status === "INACTIVE" ? <Badge tone="warning">Off</Badge> : null}
            </p>
            <p className="text-ink-700">{t.description}</p>
            <p className="text-xs text-ink-600">
              Free cancel {t.freeCancelHours} h · late {t.lateCancelRefundPct}% · no-show {t.noShowRefundPct}% · {t.maxReschedules} reschedules until {t.rescheduleMinHours} h
            </p>
            <Button size="sm" variant="secondary" className="mt-1" onClick={() => setEdit(t)}>
              Edit
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Report {
  from: string;
  to: string;
  totals: { bookings: number; completed: number; cancelled: number; noShows: number; confirmed: number; grossPaise: number; refundsPaise: number; commissionPaise: number; onlinePaise: number; offlinePaise: number };
  byStatus: { status: string; n: number }[];
  byCategory: { name: string; bookings: number; grossPaise: number; commissionPaise: number }[];
  byArea: { area: string; bookings: number; grossPaise: number }[];
  byDay: { day: string; bookings: number; grossPaise: number }[];
  topConsultants: { name: string; city: string; bookings: number; grossPaise: number; rating: number }[];
}

function Reports() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [r, setR] = useState<Report | null>(null);
  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: "report" });
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    setR(await api<Report>(`/api/admin/consult?${p.toString()}`));
  }, [from, to]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the view's inputs change
    void load();
  }, [load]);
  if (!r) return <p className="text-sm text-ink-600">Loading…</p>;
  const max = Math.max(1, ...r.byDay.map((d) => d.bookings));
  return (
    <div className="flex flex-col gap-3" data-testid="consult-report">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="From">
          <input className={inputClass} type="date" value={from || r.from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input className={inputClass} type="date" value={to || r.to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <p className="pb-2 text-xs text-ink-600">By appointment date (IST). Report time {formatIst(new Date())}.</p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Tile label="Bookings" value={r.totals.bookings} hint={`${r.totals.confirmed} upcoming`} />
        <Tile label="Completed" value={r.totals.completed} tone="green" hint={`${r.totals.noShows} no-show · ${r.totals.cancelled} cancelled`} />
        <Tile label="Revenue kept" value={rupees(r.totals.grossPaise)} tone="teal" hint={`online ${rupees(r.totals.onlinePaise)} · at visit ${rupees(r.totals.offlinePaise)}`} />
        <Tile label="Refunds" value={rupees(r.totals.refundsPaise)} tone="amber" />
        <Tile label="Commission" value={rupees(r.totals.commissionPaise)} tone="kesari" />
      </div>
      <Panel title="Bookings per day">
        <div className="flex h-32 items-end gap-1" aria-label="Bookings per day">
          {r.byDay.map((d) => (
            <div key={d.day} className="flex flex-1 flex-col items-center gap-0.5" title={`${d.day}: ${d.bookings} bookings, ${rupees(d.grossPaise)}`}>
              <div className="w-full rounded-t bg-kesari-500" style={{ height: `${(d.bookings / max) * 100}%`, minHeight: 2 }} />
            </div>
          ))}
        </div>
        {r.byDay.length === 0 ? <p className="text-sm text-ink-600">No bookings in this period.</p> : null}
      </Panel>
      <div className="grid gap-3 md:grid-cols-3">
        <Panel title="Top categories">
          <Rows rows={r.byCategory.map((c) => [c.name, `${c.bookings} · ${rupees(c.grossPaise)} · comm. ${rupees(c.commissionPaise)}`])} />
        </Panel>
        <Panel title="Top areas">
          <Rows rows={r.byArea.map((a) => [a.area, `${a.bookings} · ${rupees(a.grossPaise)}`])} />
        </Panel>
        <Panel title="Top consultants">
          <Rows rows={r.topConsultants.map((c) => [`${c.name} (${c.city})`, `${c.bookings} · ${rupees(c.grossPaise)} · ★${c.rating.toFixed(1)}`])} />
        </Panel>
      </div>
    </div>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  if (!rows.length) return <p className="text-sm text-ink-600">—</p>;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {rows.map(([a, b]) => (
        <li key={a} className="flex justify-between gap-2">
          <span className="truncate">{a}</span>
          <span className="shrink-0 tabular-nums text-ink-700">{b}</span>
        </li>
      ))}
    </ul>
  );
}
