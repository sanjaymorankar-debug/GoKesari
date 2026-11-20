"use client";

/**
 * GoKesari Health — patient screens (client parts): the notice, person switcher, record views, uploads,
 * sharing, profile, family, privacy. All data comes from /api/health/*; times shown in IST.
 */
import clsx from "clsx";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import {
  BLOOD_GROUPS,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  GENDER_LABELS,
  GENDERS,
  HEALTH_NOTICE_POINTS,
  RELATION_LABELS,
  RELATIONS,
  RX_FREQUENCY_LABELS,
  RX_TIMING_LABELS,
  SUGGESTION_TYPE_LABELS,
  TIMELINE_KINDS,
  TIMELINE_KIND_LABELS,
  type RxTiming,
  type SuggestionType,
  type TimelineKind,
} from "@/lib/health/constants";
import { api, ist, Panel } from "./api";
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY } from "./styles";
import { useHealthLive } from "./live";

export interface PersonLite {
  id: string;
  fullName: string;
  relation: string;
  linkStatus: string;
  dateOfBirth: string | null;
}

const inputCls = "min-h-11 w-full rounded-xl border-2 border-[var(--gk-line)] bg-white px-3 py-2 text-base text-ink-900 focus:border-kesari-500 focus:outline-none";

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
      {error}
    </p>
  );
}

/* ------------------------------------------------------------ notice */

export function HealthNotice() {
  const router = useRouter();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/health/me", { json: { accept: true } });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Before you start: how My Health uses your information">
      <ul className="flex flex-col gap-3 text-sm text-ink-800" data-testid="health-notice">
        {HEALTH_NOTICE_POINTS.map((p) => (
          <li key={p.heading}>
            <p className="font-extrabold text-ink-900">{p.heading}</p>
            <p>{p.text}</p>
          </li>
        ))}
      </ul>
      <label className="mt-4 flex min-h-11 items-start gap-3 text-sm font-semibold text-ink-900">
        <input type="checkbox" className="mt-1 h-5 w-5" checked={agree} onChange={(e) => setAgree(e.target.checked)} data-testid="health-notice-agree" />
        I have read this. I agree that GoKesari keeps my health record and my family&apos;s, and shares it only as described above.
      </label>
      <ErrorNote error={error} />
      <button type="button" className={clsx(BTN_PRIMARY, "mt-3 w-full sm:w-auto")} disabled={!agree || busy} onClick={accept} data-testid="health-notice-accept">
        {busy ? "Starting…" : "Agree and open My Health"}
      </button>
      <p className="mt-2 text-xs text-ink-600">The time you agree is recorded. You can withdraw sharing, download your data or delete your account at any time from Privacy.</p>
    </Panel>
  );
}

/* ------------------------------------------------------------ person switcher */

export function PersonSwitcher({ people, current, basePath }: { people: PersonLite[]; current: string; basePath: string }) {
  const search = useSearchParams();
  const href = (id: string) => {
    const p = new URLSearchParams(search?.toString() ?? "");
    p.set("patient", id);
    return `${basePath}?${p.toString()}`;
  };
  return (
    <nav aria-label="Whose record" className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1">
      {people.map((p) => (
        <Link
          key={p.id}
          href={href(p.id)}
          aria-current={p.id === current ? "page" : undefined}
          data-testid="health-person"
          className={clsx(
            "min-h-11 shrink-0 rounded-full border-2 px-4 py-2 text-sm font-extrabold",
            p.id === current ? "border-kesari-700 bg-kesari-700 text-white" : "border-[var(--gk-line)] bg-white text-ink-900 hover:border-kesari-400",
          )}
        >
          {p.relation === "SELF" ? "Me" : p.fullName.split(" ")[0]}
          {p.linkStatus === "PENDING_APPROVAL" ? " (waiting for code)" : ""}
        </Link>
      ))}
      <Link href="/health/family" className="min-h-11 shrink-0 rounded-full border-2 border-dashed border-kesari-400 px-4 py-2 text-sm font-extrabold text-kesari-800">
        + Family
      </Link>
    </nav>
  );
}

/* ------------------------------------------------------------ records */

interface TimelineItem {
  id: string;
  occurredAt: string;
  kind: string;
  title: string;
  summary: string | null;
  providerName: string | null;
  refType: string;
  refId: string;
  meta: Record<string, unknown>;
}
interface ProviderGroup {
  key: string;
  name: string;
  clinic: string | null;
  memberId: string | null;
  lastAt: string;
  items: TimelineItem[];
}
interface MedicineRow {
  itemId: string;
  prescriptionId: string;
  rxNumber: string;
  name: string;
  generic: string;
  strength: string | null;
  form: string;
  dose: string;
  frequency: string;
  timing: string;
  durationDays: number;
  start: string;
  end: string;
  current: boolean;
  doctor: string;
  instructions: string | null;
}
interface DocumentRow {
  id: string;
  title: string;
  kindLabel: string;
  sourceLabel: string;
  source: string;
  documentDate: string | null;
  providerName: string | null;
  createdAt: string;
}

const VIEWS = [
  { key: "timeline", label: "Timeline" },
  { key: "providers", label: "By doctor / provider" },
  { key: "medicines", label: "Medicines" },
  { key: "documents", label: "Reports & documents" },
] as const;
type View = (typeof VIEWS)[number]["key"];

/** Where a timeline item opens. */
function itemHref(t: Pick<TimelineItem, "refType" | "refId">): string | null {
  switch (t.refType) {
    case "prescription":
      return `/health/prescriptions/${t.refId}`;
    case "document":
      return `/api/health/documents/${t.refId}`;
    case "booking":
      return `/health/appointments/${t.refId}`;
    case "rx_order":
      return `/health/medicines/${t.refId}`;
    case "rental":
      return `/health/equipment/rentals/${t.refId}`;
    case "care_visit":
      return `/health/care/visits/${t.refId}`;
    default:
      return null;
  }
}

function TimelineList({ items, empty }: { items: TimelineItem[]; empty: ReactNode }) {
  if (!items.length) return <p className="text-sm text-ink-600">{empty}</p>;
  return (
    <ol className="flex flex-col gap-2" data-testid="health-timeline">
      {items.map((t) => {
        const href = itemHref(t);
        const body = (
          <>
            <span className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-kesari-100 px-2 py-0.5 text-xs font-extrabold text-kesari-900">{TIMELINE_KIND_LABELS[t.kind as TimelineKind] ?? t.kind}</span>
              <span className="text-xs font-semibold text-ink-600">{ist(t.occurredAt)}</span>
            </span>
            <span className="mt-1 block font-extrabold text-ink-900">{t.title}</span>
            {t.summary ? <span className="block text-sm text-ink-700">{t.summary}</span> : null}
            {t.providerName ? <span className="block text-xs text-ink-500">{t.providerName}</span> : null}
          </>
        );
        return (
          <li key={t.id}>
            {href ? (
              <Link href={href} className="block rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 hover:border-kesari-300" data-testid="health-timeline-item">
                {body}
              </Link>
            ) : (
              <div className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3" data-testid="health-timeline-item">
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function RecordsView({ patientId, initialView }: { patientId: string; initialView?: string }) {
  const [view, setView] = useState<View>((VIEWS.find((v) => v.key === initialView)?.key ?? "timeline") as View);
  const [kind, setKind] = useState<string>("");
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ timeline?: TimelineItem[]; providers?: ProviderGroup[]; medicines?: MedicineRow[]; documents?: DocumentRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ view });
      if (view === "timeline" && kind) params.set("kind", kind);
      if (view === "timeline" && q.trim()) params.set("q", q.trim());
      setData(await api(`/api/health/patients/${patientId}/records?${params.toString()}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [patientId, view, kind, q]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the view's inputs change
    void load();
  }, [load]);
  // A new prescription, report or order appears the moment it is issued.
  const live = useHealthLive((e) => e.subjectId === patientId || ["prescription.issued", "prescription.amended", "record.added", "order.completed", "care_booking.checked_out", "rental.started", "appointment.booked"].includes(e.name), () => void load());
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Record views" className="-mx-1 flex gap-2 overflow-x-auto px-1">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              role="tab"
              type="button"
              aria-selected={view === v.key}
              onClick={() => setView(v.key)}
              data-testid={`health-view-${v.key}`}
              className={clsx("min-h-11 shrink-0 rounded-xl border-2 px-3 text-sm font-extrabold", view === v.key ? "border-kesari-700 bg-kesari-50 text-kesari-900" : "border-[var(--gk-line)] bg-white text-ink-800")}
            >
              {v.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-ink-600" data-testid="health-live" data-status={live}>
          {live === "live" ? "● Live" : "○ Connecting"}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN_SECONDARY} onClick={() => setShowUpload((v) => !v)} data-testid="health-upload-open">
          ⬆ Upload an old report
        </button>
        <a className={BTN_SECONDARY} href={`/api/health/patients/${patientId}/export`} data-testid="health-export">
          ⬇ Download full record (PDF)
        </a>
      </div>
      {showUpload ? <UploadForm patientId={patientId} onDone={() => (setShowUpload(false), void load())} /> : null}
      <ErrorNote error={error} />
      {view === "timeline" ? (
        <>
          <div className="flex flex-wrap gap-2">
            <input className={clsx(inputCls, "max-w-xs")} placeholder="Search (doctor, medicine, test …)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the record" data-testid="health-search" />
            <select className={clsx(inputCls, "max-w-xs")} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Show only">
              <option value="">Everything</option>
              {TIMELINE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TIMELINE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          {data?.timeline ? <TimelineList items={data.timeline} empty="Nothing here yet. Book a doctor, upload an old report or add your profile details." /> : <p className="text-sm text-ink-600">Loading…</p>}
        </>
      ) : null}
      {view === "providers" ? (
        data?.providers ? (
          data.providers.length ? (
            <div className="flex flex-col gap-3" data-testid="health-providers">
              {data.providers.map((g) => (
                <details key={g.key} className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3" open={data.providers!.length <= 3}>
                  <summary className="cursor-pointer list-none">
                    <span className="block font-extrabold text-ink-900">{g.name}</span>
                    <span className="block text-xs text-ink-600">
                      {g.clinic ? `${g.clinic} · ` : ""}
                      {g.items.length} items · last {ist(g.lastAt, false)}
                    </span>
                  </summary>
                  <div className="mt-3">
                    <TimelineList items={g.items} empty="" />
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-600">No doctors or providers yet.</p>
          )
        ) : (
          <p className="text-sm text-ink-600">Loading…</p>
        )
      ) : null}
      {view === "medicines" ? (
        data?.medicines ? (
          data.medicines.length ? (
            <ul className="flex flex-col gap-2" data-testid="health-medicines">
              {data.medicines.map((m) => (
                <li key={m.itemId} className={clsx("rounded-2xl border-2 p-3", m.current ? "border-leaf-400 bg-leaf-50" : "border-[var(--gk-line)] bg-white")}>
                  <p className="flex flex-wrap items-center gap-2 font-extrabold text-ink-900">
                    {m.current ? <span className="rounded-full bg-leaf-700 px-2 py-0.5 text-xs text-white">Current</span> : <span className="rounded-full bg-stone-200 px-2 py-0.5 text-xs text-ink-700">Past</span>}
                    {m.name} {m.strength}
                  </p>
                  <p className="text-sm text-ink-800">
                    {m.dose} · {RX_FREQUENCY_LABELS[m.frequency]?.en ?? m.frequency} · {RX_TIMING_LABELS[m.timing as RxTiming]?.en ?? m.timing} · {m.durationDays} days
                  </p>
                  {m.instructions ? <p className="text-sm text-ink-700">{m.instructions}</p> : null}
                  <p className="text-xs text-ink-600">
                    {m.start} to {m.end} · {m.doctor} ·{" "}
                    <Link className="font-bold text-kesari-800 underline" href={`/health/prescriptions/${m.prescriptionId}`}>
                      {m.rxNumber}
                    </Link>
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-600">No medicines from GoKesari prescriptions yet.</p>
          )
        ) : (
          <p className="text-sm text-ink-600">Loading…</p>
        )
      ) : null}
      {view === "documents" ? (
        data?.documents ? (
          data.documents.length ? (
            <ul className="flex flex-col gap-2" data-testid="health-documents">
              {data.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3">
                  <span className="min-w-0">
                    <span className="block font-extrabold text-ink-900">{d.title}</span>
                    <span className="block text-xs text-ink-600">
                      {d.kindLabel} · {d.sourceLabel}
                      {d.providerName ? ` · ${d.providerName}` : ""} · {d.documentDate ?? ist(d.createdAt, false)}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    <a className={BTN_SECONDARY} href={`/api/health/documents/${d.id}`} target="_blank" rel="noreferrer">
                      Open
                    </a>
                    <ShareButton patientId={patientId} objectType="DOCUMENT" objectId={d.id} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-600">No reports yet. Upload old lab reports, scans or discharge summaries above.</p>
          )
        ) : (
          <p className="text-sm text-ink-600">Loading…</p>
        )
      ) : null}
    </div>
  );
}

function UploadForm({ patientId, onDone }: { patientId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/health/patients/${patientId}/documents`, { method: "POST", body: new FormData(e.currentTarget) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? "Upload failed.");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="grid gap-2 rounded-2xl border-2 border-kesari-200 bg-kesari-50 p-3 sm:grid-cols-2" data-testid="health-upload-form">
      <label className="text-sm font-bold text-ink-900 sm:col-span-2">
        File (PDF, JPG, PNG)
        <input name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required className="mt-1 block w-full text-sm" />
      </label>
      <label className="text-sm font-bold text-ink-900">
        Name
        <input name="title" required className={inputCls} placeholder="e.g. Blood test" />
      </label>
      <label className="text-sm font-bold text-ink-900">
        Type
        <select name="kind" className={inputCls} defaultValue="LAB_REPORT">
          {DOCUMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {DOCUMENT_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-bold text-ink-900">
        Date of the report
        <input name="documentDate" type="date" className={inputCls} />
      </label>
      <label className="text-sm font-bold text-ink-900">
        From (lab / hospital)
        <input name="providerName" className={inputCls} />
      </label>
      <div className="sm:col-span-2">
        <ErrorNote error={error} />
        <button className={BTN_PRIMARY} disabled={busy} data-testid="health-upload-submit">
          {busy ? "Uploading…" : "Upload"}
        </button>
        <span className="ml-2 text-xs text-ink-600">Stored encrypted; tagged &quot;Patient uploaded&quot;.</span>
      </div>
    </form>
  );
}

export function ShareButton({ patientId, objectType, objectId }: { patientId: string; objectType: "PRESCRIPTION" | "DOCUMENT"; objectId: string }) {
  const [state, setState] = useState<string | null>(null);
  const share = async () => {
    try {
      const r = await api<{ url: string; expiresAt: string }>(`/api/health/patients/${patientId}/share`, { json: { objectType, objectId } });
      const url = `${window.location.origin}${r.url}`;
      const text = `My GoKesari health record (link works until ${ist(r.expiresAt)}): ${url}`;
      if (navigator.share) await navigator.share({ title: "GoKesari Health", text, url }).catch(() => undefined);
      else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
      setState(`Link ready (until ${ist(r.expiresAt)})`);
    } catch (e) {
      setState((e as Error).message);
    }
  };
  return (
    <span className="inline-flex flex-col">
      <button type="button" className={BTN_SECONDARY} onClick={share} data-testid="health-share">
        Share
      </button>
      {state ? <span className="text-xs text-ink-600">{state}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------ profile */

interface PatientFull extends PersonLite {
  gender: string | null;
  bloodGroup: string | null;
  allergies: string[];
  conditions: string[];
  currentMedicines: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
  emergencyRelation: string | null;
  abhaNumber: string | null;
  recordStartAt: string;
}

const splitList = (v: string) =>
  v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

export function ProfileForm({ patient }: { patient: PatientFull }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => (String(f.get(k) ?? "").trim() || null);
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api(`/api/health/patients/${patient.id}`, {
        json: {
          fullName: get("fullName"),
          dateOfBirth: get("dateOfBirth"),
          gender: get("gender"),
          bloodGroup: get("bloodGroup"),
          allergies: splitList(String(f.get("allergies") ?? "")),
          conditions: splitList(String(f.get("conditions") ?? "")),
          currentMedicines: get("currentMedicines"),
          emergencyName: get("emergencyName"),
          emergencyPhone: get("emergencyPhone"),
          emergencyRelation: get("emergencyRelation"),
          abhaNumber: get("abhaNumber"),
        },
      });
      setMsg("Saved.");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" data-testid="health-profile-form">
      <label className="text-sm font-bold text-ink-900">
        Full name *
        <input name="fullName" required defaultValue={patient.fullName} className={inputCls} />
      </label>
      <label className="text-sm font-bold text-ink-900">
        Date of birth *
        <input name="dateOfBirth" type="date" defaultValue={patient.dateOfBirth ?? ""} className={inputCls} />
      </label>
      <label className="text-sm font-bold text-ink-900">
        Gender
        <select name="gender" defaultValue={patient.gender ?? ""} className={inputCls}>
          <option value="">—</option>
          {GENDERS.map((g) => (
            <option key={g} value={g}>
              {GENDER_LABELS[g]}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-bold text-ink-900">
        Blood group
        <select name="bloodGroup" defaultValue={patient.bloodGroup ?? ""} className={inputCls}>
          <option value="">—</option>
          {BLOOD_GROUPS.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
      </label>
      <label className="text-sm font-bold text-red-800 sm:col-span-2">
        Allergies (comma separated) — shown to your doctors in red
        <input name="allergies" defaultValue={patient.allergies.join(", ")} className={inputCls} placeholder="e.g. Penicillin, Sulfa" data-testid="health-allergies" />
      </label>
      <label className="text-sm font-bold text-ink-900 sm:col-span-2">
        Long-term conditions
        <input name="conditions" defaultValue={patient.conditions.join(", ")} className={inputCls} placeholder="e.g. Diabetes, Asthma" />
      </label>
      <label className="text-sm font-bold text-ink-900 sm:col-span-2">
        Medicines you take now (not from GoKesari)
        <textarea name="currentMedicines" defaultValue={patient.currentMedicines ?? ""} className={inputCls} rows={2} />
      </label>
      <label className="text-sm font-bold text-ink-900">
        Emergency contact name
        <input name="emergencyName" defaultValue={patient.emergencyName ?? ""} className={inputCls} />
      </label>
      <label className="text-sm font-bold text-ink-900">
        Emergency contact mobile
        <input name="emergencyPhone" inputMode="tel" defaultValue={patient.emergencyPhone ?? ""} className={inputCls} />
      </label>
      <label className="text-sm font-bold text-ink-900">
        Relation
        <input name="emergencyRelation" defaultValue={patient.emergencyRelation ?? ""} className={inputCls} />
      </label>
      <label className="text-sm font-bold text-ink-900">
        ABHA number (optional)
        <input name="abhaNumber" inputMode="numeric" defaultValue={patient.abhaNumber ?? ""} className={inputCls} placeholder="14 digits" />
      </label>
      <div className="sm:col-span-2">
        <ErrorNote error={error} />
        {msg ? <p className="text-sm font-bold text-leaf-800">{msg}</p> : null}
        <button className={BTN_PRIMARY} disabled={busy} data-testid="health-profile-save">
          {busy ? "Saving…" : "Save profile"}
        </button>
        <p className="mt-1 text-xs text-ink-600">Record kept since {ist(patient.recordStartAt)}.</p>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------ family */

export function FamilyManager({ people }: { people: PersonLite[] }) {
  const router = useRouter();
  const [dependent, setDependent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; sentTo: string | null } | null>(null);
  const [code, setCode] = useState("");
  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ patient: { id: string; linkStatus: string }; codeSentTo: string | null }>("/api/health/family", {
        json: {
          fullName: String(f.get("fullName") ?? ""),
          relation: String(f.get("relation") ?? "CHILD"),
          dateOfBirth: String(f.get("dateOfBirth") ?? "") || null,
          gender: String(f.get("gender") ?? "") || null,
          dependent,
          phone: String(f.get("phone") ?? "") || null,
          email: String(f.get("email") ?? "") || null,
        },
      });
      if (r.patient.linkStatus === "PENDING_APPROVAL") setPending({ id: r.patient.id, sentTo: r.codeSentTo });
      (e.target as HTMLFormElement).reset();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = async (id: string, action: "confirm" | "resend" | "remove", extra: Record<string, unknown> = {}) => {
    setError(null);
    try {
      const r = await api<{ codeSentTo?: string | null }>(`/api/health/family/${id}`, { json: { action, ...extra } });
      if (action === "resend") setPending({ id, sentTo: r.codeSentTo ?? null });
      if (action === "confirm") setPending(null);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2" data-testid="health-family-list">
        {people.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3">
            <span>
              <span className="block font-extrabold text-ink-900">{p.fullName}</span>
              <span className="block text-xs text-ink-600">
                {RELATION_LABELS[p.relation as keyof typeof RELATION_LABELS] ?? p.relation}
                {p.dateOfBirth ? ` · born ${p.dateOfBirth}` : ""}
                {p.linkStatus === "PENDING_APPROVAL" ? " · waiting for their code" : ""}
              </span>
            </span>
            <span className="flex flex-wrap gap-2">
              <Link className={BTN_SECONDARY} href={`/health/records?patient=${p.id}`}>
                Records
              </Link>
              <Link className={BTN_SECONDARY} href={`/health/profile?patient=${p.id}`}>
                Profile
              </Link>
              {p.linkStatus === "PENDING_APPROVAL" ? (
                <button type="button" className={BTN_SECONDARY} onClick={() => act(p.id, "resend")}>
                  Send code again
                </button>
              ) : null}
              {p.relation !== "SELF" ? (
                <button type="button" className={BTN_DANGER} onClick={() => confirm(`Remove ${p.fullName} from your account? Medical records are kept as the law requires but hidden.`) && act(p.id, "remove")}>
                  Remove
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {pending ? (
        <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-3" data-testid="health-family-code">
          <p className="text-sm font-bold text-ink-900">We sent a one-time code{pending.sentTo ? ` to ${pending.sentTo}` : ""}. Ask them for it and enter it here to link their record.</p>
          <div className="mt-2 flex gap-2">
            <input className={clsx(inputCls, "max-w-[10rem]")} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code" data-testid="health-family-code-input" />
            <button type="button" className={BTN_PRIMARY} onClick={() => act(pending.id, "confirm", { code })} data-testid="health-family-code-submit">
              Link
            </button>
          </div>
        </div>
      ) : null}
      <Panel title="Add a family member">
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-2" data-testid="health-family-form">
          <label className="text-sm font-bold text-ink-900">
            Name
            <input name="fullName" required className={inputCls} />
          </label>
          <label className="text-sm font-bold text-ink-900">
            Relation
            <select name="relation" className={inputCls} defaultValue="CHILD">
              {RELATIONS.filter((r) => r !== "SELF").map((r) => (
                <option key={r} value={r}>
                  {RELATION_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-bold text-ink-900">
            Date of birth
            <input name="dateOfBirth" type="date" className={inputCls} />
          </label>
          <label className="text-sm font-bold text-ink-900">
            Gender
            <select name="gender" className={inputCls} defaultValue="">
              <option value="">—</option>
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {GENDER_LABELS[g]}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="sm:col-span-2">
            <legend className="text-sm font-bold text-ink-900">Who manages this record?</legend>
            <label className="mt-1 flex min-h-11 items-center gap-2 text-sm">
              <input type="radio" checked={dependent} onChange={() => setDependent(true)} /> I manage everything (a child, or an elderly parent who depends on me)
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="radio" checked={!dependent} onChange={() => setDependent(false)} data-testid="health-family-adult" /> An adult — they approve with a one-time code
            </label>
          </fieldset>
          {!dependent ? (
            <>
              <label className="text-sm font-bold text-ink-900">
                Their mobile
                <input name="phone" inputMode="tel" className={inputCls} />
              </label>
              <label className="text-sm font-bold text-ink-900">
                or e-mail
                <input name="email" type="email" className={inputCls} />
              </label>
            </>
          ) : null}
          <div className="sm:col-span-2">
            <ErrorNote error={error} />
            <button className={BTN_PRIMARY} disabled={busy} data-testid="health-family-add">
              {busy ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------ privacy */

interface ConsentRow {
  id: string;
  kind: string;
  mode: string;
  who: string;
  text: string;
  grantedAt: string;
  revokedAt: string | null;
}
interface LogRow {
  id: string;
  actorLabel: string;
  actorRole: string;
  action: string;
  objectType: string;
  reason: string | null;
  createdAt: string;
}

const ACTION_LABEL: Record<string, string> = {
  VIEW: "Viewed",
  PRINT: "Printed",
  DOWNLOAD: "Downloaded",
  SHARE: "Shared",
  EXPORT: "Exported",
  BREAK_GLASS: "Emergency access",
  CONSENT_GRANTED: "Sharing allowed",
  CONSENT_REVOKED: "Sharing withdrawn",
  UPDATE: "Updated",
};

export function PrivacyView({ patientId, ask }: { patientId: string; ask?: { memberId: string; bookingId: string | null } | null }) {
  const [consents, setConsents] = useState<ConsentRow[] | null>(null);
  const [log, setLog] = useState<LogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [c, l] = await Promise.all([api<{ consents: ConsentRow[] }>(`/api/health/patients/${patientId}/consents`), api<{ log: LogRow[] }>(`/api/health/patients/${patientId}/access-log`)]);
      setConsents(c.consents);
      setLog(l.log);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [patientId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the view's inputs change
    void load();
  }, [load]);
  useHealthLive((e) => e.subjectId === patientId && (e.name.startsWith("consent.") || e.name === "record.accessed"), () => void load());
  const revoke = async (id: string) => {
    try {
      await api(`/api/health/consents/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const allow = async (mode: "THIS_BOOKING" | "ALWAYS" | "OFF") => {
    if (!ask) return;
    try {
      await api(`/api/health/patients/${patientId}/consents`, { json: { memberId: ask.memberId, mode, bookingId: ask.bookingId } });
      setMsg(mode === "OFF" ? "The doctor will not see your earlier records." : "Done — the doctor can now see your earlier records.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const dataRequest = async (kind: "EXPORT" | "DELETE") => {
    if (kind === "DELETE" && !confirm("Delete my account's health records from my view? Prescriptions and consultation notes are kept (hidden, restricted) for at least 3 years as medical law requires. This cannot be undone from the app.")) return;
    try {
      await api("/api/health/privacy", { json: { kind } });
      setMsg(kind === "EXPORT" ? "Request received. You can also download each person's full record as a PDF from Records now." : "Request received. Your health records are hidden from your account.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const active = useMemo(() => (consents ?? []).filter((c) => !c.revokedAt && c.kind !== "HEALTH_NOTICE" && c.mode !== "OFF"), [consents]);
  return (
    <div className="flex flex-col gap-4">
      <ErrorNote error={error} />
      {msg ? <p className="rounded-xl border-2 border-leaf-300 bg-leaf-50 px-3 py-2 text-sm font-bold text-leaf-900">{msg}</p> : null}
      {ask ? (
        <Panel title="A doctor asks to see your earlier records">
          <p className="text-sm text-ink-800">Allow it for this visit only, always for this doctor, or not at all. You can withdraw it here at any time.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={() => allow("THIS_BOOKING")} data-testid="health-allow-visit">
              Allow for this visit
            </button>
            <button type="button" className={BTN_SECONDARY} onClick={() => allow("ALWAYS")}>
              Always allow this doctor
            </button>
            <button type="button" className={BTN_DANGER} onClick={() => allow("OFF")}>
              Don&apos;t allow
            </button>
          </div>
        </Panel>
      ) : null}
      <Panel title="Who can see my earlier records">
        {consents == null ? (
          <p className="text-sm text-ink-600">Loading…</p>
        ) : active.length ? (
          <ul className="flex flex-col gap-2" data-testid="health-consents">
            {active.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-[var(--gk-line)] p-3">
                <span className="min-w-0">
                  <span className="block font-extrabold text-ink-900">{c.who}</span>
                  <span className="block text-xs text-ink-600">
                    {c.mode === "ALWAYS" ? "Always" : c.mode === "THIS_BOOKING" ? "For one visit" : "Asks each time"} · since {ist(c.grantedAt)}
                  </span>
                </span>
                <button type="button" className={BTN_DANGER} onClick={() => revoke(c.id)} data-testid="health-revoke">
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-600">Nobody. Doctors see only their own consultations with you.</p>
        )}
      </Panel>
      <Panel title="Access log — who opened what">
        {log == null ? (
          <p className="text-sm text-ink-600">Loading…</p>
        ) : log.length ? (
          <ul className="flex flex-col divide-y divide-[var(--gk-line)]" data-testid="health-access-log">
            {log.map((l) => (
              <li key={l.id} className="py-2 text-sm">
                <span className="font-extrabold text-ink-900">{ACTION_LABEL[l.action] ?? l.action}</span> · {l.objectType.replace(/_/g, " ")} · <span className="text-ink-800">{l.actorLabel}</span>
                <span className="block text-xs text-ink-600">
                  {ist(l.createdAt)}
                  {l.reason ? ` · ${l.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-600">No one has opened your record yet.</p>
        )}
      </Panel>
      <Panel title="My data">
        <div className="flex flex-wrap gap-2">
          <a className={BTN_SECONDARY} href={`/api/health/patients/${patientId}/export`}>
            Download this record (PDF)
          </a>
          <button type="button" className={BTN_SECONDARY} onClick={() => dataRequest("EXPORT")}>
            Request all my data
          </button>
          <button type="button" className={BTN_DANGER} onClick={() => dataRequest("DELETE")} data-testid="health-delete-request">
            Delete my account&apos;s health records
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-600">
          Questions or complaints: <Link href="/grievance" className="font-bold underline">Grievance Officer</Link>.
        </p>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------ prescription extras */

export interface SuggestionCard {
  id: string;
  type: string;
  status: string;
  text: string;
  targetMemberId: string | null;
  details: Record<string, unknown>;
  linkedBookingId: string | null;
  linkedRxOrderId: string | null;
  linkedRentalId: string | null;
}

/** "Book now" for each suggestion: the right flow with the suggestion carried through. */
export function bookNowHref(s: SuggestionCard): string {
  const d = s.details as { specialty?: string; careCategory?: string; equipment?: string; followUpDate?: string };
  switch (s.type as SuggestionType) {
    case "DOCTOR_REFERRAL":
      return s.targetMemberId ? `/health/doctors/${s.targetMemberId}?suggestion=${s.id}` : `/health/doctors?specialty=${encodeURIComponent(d.specialty ?? "")}&suggestion=${s.id}`;
    case "CARE_STAFF":
      return `/health/care?category=${encodeURIComponent(d.careCategory ?? "")}&suggestion=${s.id}`;
    case "EQUIPMENT":
      return `/health/equipment?q=${encodeURIComponent(d.equipment ?? "")}&suggestion=${s.id}`;
    case "LAB_TEST":
      return `/health/care?category=home-sample-collection&suggestion=${s.id}`;
    case "FOLLOW_UP":
      return `/health/doctors/${(s.details as { memberId?: string }).memberId ?? ""}?suggestion=${s.id}${d.followUpDate ? `&date=${d.followUpDate}` : ""}`;
  }
}

export function SuggestionList({ items, followUpMemberId }: { items: SuggestionCard[]; followUpMemberId: string }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-col gap-2" data-testid="health-suggestions">
      {items.map((s) => {
        const card = s.type === "FOLLOW_UP" ? { ...s, details: { ...s.details, memberId: followUpMemberId } } : s;
        return (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-teal-200 bg-teal-50 p-3">
            <span className="min-w-0">
              <span className="block text-xs font-extrabold uppercase tracking-wide text-teal-900">{SUGGESTION_TYPE_LABELS[s.type as SuggestionType] ?? s.type}</span>
              <span className="block text-sm font-bold text-ink-900">{s.text}</span>
            </span>
            {s.status === "OPEN" ? (
              <Link className={BTN_PRIMARY} href={bookNowHref(card)} data-testid="health-book-now">
                Book now
              </Link>
            ) : (
              <span className="rounded-full bg-leaf-100 px-3 py-1 text-xs font-extrabold text-leaf-900">{s.status === "BOOKED" ? "Booked" : s.status === "DONE" ? "Done" : "Dismissed"}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
