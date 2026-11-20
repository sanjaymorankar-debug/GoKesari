"use client";

/**
 * Health admin → Break-glass (admins: an emergency, read-only look at one patient's record for 30 minutes;
 * every open is logged with the reason and the patient's account is told) and Data requests (DPDP export /
 * delete requests: mark done or reject with a note).
 */
import { useCallback, useEffect, useState } from "react";

import { Alert, Badge, Button, Field, inputClass } from "@/components/ui";
import { api, Chip, ist, Panel } from "./api";
import { ADMIN_API, card, Detail, Loading, Nothing, type Post } from "./admin-common";

interface Found {
  id: string;
  initials: string;
  relation: string;
  birthYear: string | null;
}

interface View {
  accessLogId: string;
  openedAt: string;
  expiresAt: string;
  patient: {
    id: string;
    fullName: string;
    relation: string;
    dateOfBirth: string | null;
    gender: string | null;
    bloodGroup: string | null;
    allergies: string[];
    conditions: string[];
    currentMedicines: string | null;
    emergencyName: string | null;
    emergencyPhone: string | null;
    emergencyRelation: string | null;
  };
  timeline: { id: string; at: string; kind: string; title: string; summary: string | null; provider: string | null }[];
  prescriptions: { id: string; rxNumber: string; version: number; status: string; issuedAt: string; doctor: string; clinic: string; items: { name: string; dose: string; frequency: string; durationDays: number }[] }[];
}

const MIN_REASON = 20;

export function BreakGlass({ post, enabled }: { post: Post; enabled: boolean }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [patientId, setPatientId] = useState("");
  const [reason, setReason] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (!view) return;
    const tick = () => {
      const ms = new Date(view.expiresAt).getTime() - Date.now();
      if (ms <= 0) {
        setView(null);
        setLeft(0);
      } else setLeft(Math.ceil(ms / 1000));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [view]);

  if (!enabled) return <Alert tone="warning">Emergency access is switched off (rule health → breakGlassEnabled).</Alert>;

  const find = async () => {
    const res = await post<{ patients: Found[] }>({ action: "findPatient", q }, (r) => (r.patients.length ? `${r.patients.length} patient record(s) found.` : "No patient record found."));
    setFound(res?.patients ?? null);
    if (res?.patients.length === 1) setPatientId(res.patients[0].id);
  };
  const open = async () => {
    const res = await post<View>({ action: "breakGlass", patientId, reason }, "Record opened. This open is in the patient's access log and their account has been told.");
    if (res) {
      setView(res);
      setReason("");
    }
  };

  if (view) {
    const p = view.patient;
    return (
      <div className="flex flex-col gap-3" data-testid="health-breakglass-view">
        <Alert tone="danger" title="Emergency access — read only">
          Opened {ist(view.openedAt)}. Closes in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}. Do not copy or share these details.
        </Alert>
        <div>
          <Button variant="secondary" onClick={() => setView(null)} data-testid="health-breakglass-close">
            Close the record now
          </Button>
        </div>
        <Panel title={p.fullName}>
          <div className="grid gap-1 sm:grid-cols-2">
            <Detail label="Relation to account">{p.relation.toLowerCase()}</Detail>
            <Detail label="Born">{p.dateOfBirth ?? "—"}</Detail>
            <Detail label="Gender">{p.gender?.toLowerCase() ?? "—"}</Detail>
            <Detail label="Blood group">{p.bloodGroup ?? "—"}</Detail>
            <Detail label="Allergies">{p.allergies.length ? p.allergies.join(", ") : "None recorded"}</Detail>
            <Detail label="Conditions">{p.conditions.length ? p.conditions.join(", ") : "None recorded"}</Detail>
            <Detail label="Current medicines">{p.currentMedicines || "—"}</Detail>
            <Detail label="Emergency contact">{p.emergencyName ? `${p.emergencyName}${p.emergencyRelation ? ` (${p.emergencyRelation})` : ""} ${p.emergencyPhone ?? ""}` : "—"}</Detail>
          </div>
        </Panel>
        <Panel title={`Prescriptions (${view.prescriptions.length})`}>
          {view.prescriptions.length === 0 ? <p className="text-sm text-ink-600">None.</p> : null}
          <ul className="flex flex-col gap-2">
            {view.prescriptions.map((r) => (
              <li key={r.id} className="rounded-xl bg-cream-50 p-2 text-sm">
                <p className="font-bold">
                  {r.rxNumber}
                  {r.version > 1 ? ` v${r.version}` : ""} <Badge tone={r.status === "ISSUED" ? "success" : "neutral"}>{r.status.toLowerCase()}</Badge>
                </p>
                <p className="text-xs text-ink-600">
                  {ist(r.issuedAt)} · {r.doctor}, {r.clinic}
                </p>
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {r.items.map((i, n) => (
                    <li key={n}>
                      {i.name} — {i.dose}, {i.frequency}, {i.durationDays} days
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={`Timeline (${view.timeline.length})`}>
          <ul className="flex flex-col">
            {view.timeline.map((t) => (
              <li key={t.id} className="border-b border-cream-100 py-1.5 text-sm">
                <p>
                  <Badge>{t.kind.replace(/_/g, " ").toLowerCase()}</Badge> <strong>{t.title}</strong>
                </p>
                <p className="text-xs text-ink-600">
                  {ist(t.at)}
                  {t.provider ? ` · ${t.provider}` : ""}
                  {t.summary ? ` · ${t.summary}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="health-breakglass">
      <Alert tone="warning" title="Emergencies only">
        Opening a record writes your name and reason to the patient&apos;s access log and tells their account at once. The record closes after 30 minutes; each open is a new entry.
      </Alert>
      <Panel title="1. Find the patient">
        <div className="flex flex-wrap gap-2">
          <input className={`${inputClass} max-w-md`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Patient id, or the account's e-mail or mobile" aria-label="Patient id, e-mail or mobile" data-testid="health-breakglass-find-input" />
          <Button variant="secondary" onClick={find} disabled={q.trim().length < 3} data-testid="health-breakglass-find">
            Find
          </Button>
        </div>
        {found && found.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1">
            {found.map((f) => (
              <li key={f.id}>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="radio" name="bg-patient" checked={patientId === f.id} onChange={() => setPatientId(f.id)} />
                  <span className="font-mono font-bold">{f.initials}</span> {f.relation.toLowerCase()}
                  {f.birthYear ? `, born ${f.birthYear}` : ""} <span className="font-mono text-xs text-ink-500">{f.id}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
      <Panel title="2. Reason">
        <Field label="Why this record must be opened now" hint={`At least ${MIN_REASON} characters. The patient sees that the record was opened; the reason stays in the access log.`}>
          <textarea className={`${inputClass} min-h-24`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} data-testid="health-breakglass-reason" />
        </Field>
        <p className="mt-1 text-xs text-ink-600">{reason.trim().length} / {MIN_REASON} characters</p>
        <Button variant="danger" className="mt-2" disabled={!patientId || reason.trim().length < MIN_REASON} onClick={open} data-testid="health-breakglass-open">
          Open the record (logged)
        </Button>
      </Panel>
    </div>
  );
}

interface DataRequest {
  id: string;
  kind: string;
  status: string;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  userPhone: string | null;
  patients: number;
}

export function DataRequests({ post }: { post: Post }) {
  const [status, setStatus] = useState("OPEN");
  const [rows, setRows] = useState<DataRequest[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    setRows((await api<{ requests: DataRequest[] }>(`${ADMIN_API}?view=dataRequests&status=${status}`)).requests);
  }, [status]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the filter changes
    void load();
  }, [load]);
  const decide = async (r: DataRequest, decision: "DONE" | "REJECTED") => {
    if (await post({ action: "dataRequest", id: r.id, decision, note: notes[r.id]?.trim() || null }, decision === "DONE" ? "Marked done. The account holder is told." : "Rejected. The account holder sees your note.")) await load();
  };
  return (
    <div className="flex flex-col gap-2" data-testid="health-requests">
      <div className="flex flex-wrap gap-1.5">
        {["OPEN", "DONE", "REJECTED", "ALL"].map((s) => (
          <Chip key={s} active={status === s} onClick={() => setStatus(s)}>
            {s === "ALL" ? "All" : s[0] + s.slice(1).toLowerCase()}
          </Chip>
        ))}
      </div>
      <p className="text-xs text-ink-600">
        Export: the account holder downloads all their health data themselves (My Health → Privacy → Download my data); mark the request done once they are told. Delete: the records were hidden from the account when asked; prescriptions and consultation notes stay locked for the legal retention period.
      </p>
      {rows === null ? <Loading /> : rows.length === 0 ? <Nothing>No requests here.</Nothing> : null}
      {(rows ?? []).map((r) => (
        <div key={r.id} className={card} data-testid="health-request-card">
          <p className="flex flex-wrap items-center gap-1.5">
            <Badge tone={r.kind === "DELETE" ? "danger" : "info"}>{r.kind === "DELETE" ? "Delete" : "Export"}</Badge>
            <Badge tone={r.status === "OPEN" ? "warning" : r.status === "DONE" ? "success" : "neutral"}>{r.status.toLowerCase()}</Badge>
            <strong>{r.userName ?? "—"}</strong>
            <span className="text-xs text-ink-600">
              {r.userEmail} {r.userPhone ? `· ${r.userPhone}` : ""} · {r.patients} patient record(s)
            </span>
          </p>
          <p className="text-xs text-ink-600">
            Asked {ist(r.createdAt)}
            {r.completedAt ? ` · closed ${ist(r.completedAt)}` : ""}
          </p>
          {r.note ? <p className="mt-1 whitespace-pre-wrap text-sm">{r.note}</p> : null}
          {r.status === "OPEN" ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input className={`${inputClass} max-w-sm`} placeholder="Note (needed to reject)" value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} aria-label="Note" />
              <Button size="sm" onClick={() => decide(r, "DONE")} data-testid="health-request-done">
                Mark done
              </Button>
              <Button size="sm" variant="secondary" onClick={() => decide(r, "REJECTED")} data-testid="health-request-reject">
                Reject
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
