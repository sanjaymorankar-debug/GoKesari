"use client";

/**
 * Health admin → Reports (counts by day / week / month, CSV per table) and Access & audit (who opened
 * which record; health audit rows). Metadata only: patients appear as initials and a short id.
 */
import { useCallback, useEffect, useState } from "react";

import { ACCESS_ACTIONS } from "@/lib/health/constants";
import { Alert, Badge, Button, Field, inputClass } from "@/components/ui";
import { api, Chip, ist, Panel } from "./api";
import { ADMIN_API, downloadText, Loading, Nothing, toCsv } from "./admin-common";

interface ReportTable {
  key: string;
  title: string;
  columns: string[];
  rows: (string | number)[][];
  note?: string;
}

interface Report {
  from: string;
  to: string;
  granularity: "day" | "week" | "month";
  tables: ReportTable[];
}

export function Reports() {
  const [granularity, setGranularity] = useState<"day" | "week" | "month">("day");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: "report", granularity });
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    try {
      setError(null);
      setR(await api<Report>(`${ADMIN_API}?${p.toString()}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the report.");
    }
  }, [granularity, from, to]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the period changes
    void load();
  }, [load]);
  return (
    <div className="flex flex-col gap-3" data-testid="health-reports">
      <div className="flex flex-wrap items-end gap-2">
        {(["day", "week", "month"] as const).map((g) => (
          <Chip key={g} active={granularity === g} onClick={() => setGranularity(g)} testId={`health-report-${g}`}>
            By {g}
          </Chip>
        ))}
        <Field label="From">
          <input className={`${inputClass} w-40`} type="date" value={from || r?.from || ""} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input className={`${inputClass} w-40`} type="date" value={to || r?.to || ""} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <p className="text-xs text-ink-600">Counts and amounts only (IST) — no diagnoses, complaints or medicine names. Report time {ist(new Date())}.</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!r ? <Loading /> : null}
      {(r?.tables ?? []).map((t) => (
        <Panel
          key={t.key}
          title={t.title}
          action={
            <Button size="sm" variant="secondary" onClick={() => downloadText(`health-${t.key}-${r!.from}-to-${r!.to}.csv`, toCsv(t.columns, t.rows))} data-testid={`health-report-csv-${t.key}`}>
              CSV
            </Button>
          }
        >
          {t.rows.length === 0 ? (
            <p className="text-sm text-ink-600">Nothing in this period.</p>
          ) : (
            <div className="overflow-x-auto" data-testid={`health-report-${t.key}`}>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-ink-600">
                  <tr>
                    {t.columns.map((c) => (
                      <th key={c} className="whitespace-nowrap p-1.5">
                        {c.replace(/_/g, " ")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((row, i) => (
                    <tr key={i} className={`border-t border-cream-100 ${row[0] === "Total" ? "font-bold" : ""}`}>
                      {row.map((v, j) => (
                        <td key={j} className={`whitespace-nowrap p-1.5 ${j > 0 ? "text-right tabular-nums" : ""}`}>
                          {typeof v === "number" ? v.toLocaleString("en-IN") : v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {t.note ? <p className="mt-1 text-xs text-ink-600">{t.note}</p> : null}
        </Panel>
      ))}
    </div>
  );
}

interface AccessRow {
  id: string;
  at: string;
  patientId: string;
  patient: string;
  actorRole: string;
  actorLabel: string;
  action: string;
  objectType: string;
  objectId: string | null;
  reason: string | null;
  hasReason: boolean;
}

interface AuditRow {
  id: string;
  at: string;
  action: string;
  actor: string;
  actorRole: string | null;
  entityType: string;
  entityId: string | null;
  change: string;
}

export function AccessLogs() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [action, setAction] = useState("");
  const [role, setRole] = useState("");
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: "accessLog" });
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (action) p.set("action", action);
    if (role) p.set("role", role);
    const a = new URLSearchParams({ view: "audit" });
    if (from) a.set("from", from);
    if (to) a.set("to", to);
    const [log, au] = await Promise.all([api<{ rows: AccessRow[]; roles: string[] }>(`${ADMIN_API}?${p.toString()}`), api<{ rows: AuditRow[] }>(`${ADMIN_API}?${a.toString()}`)]);
    setRows(log.rows);
    setRoles(log.roles);
    setAudit(au.rows);
  }, [from, to, action, role]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the filters change
    void load();
  }, [load]);
  const reasonText = (r: AccessRow) => r.reason ?? (r.hasReason ? "Reason recorded" : "");
  return (
    <div className="flex flex-col gap-3" data-testid="health-logs">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="From">
          <input className={`${inputClass} w-40`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input className={`${inputClass} w-40`} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Action">
          <select className={`${inputClass} w-auto`} value={action} onChange={(e) => setAction(e.target.value)} data-testid="health-log-action">
            <option value="">Any</option>
            {ACCESS_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Who">
          <select className={`${inputClass} w-auto`} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Anyone</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Panel
        title="Record access log"
        action={
          <Button
            size="sm"
            variant="secondary"
            disabled={!rows?.length}
            onClick={() => downloadText("health-access-log.csv", toCsv(["Time (IST)", "Patient id", "Patient", "Who", "Role", "Action", "Object", "Object id", "Reason"], (rows ?? []).map((r) => [ist(r.at), r.patientId, r.patient, r.actorLabel, r.actorRole, r.action, r.objectType, r.objectId, reasonText(r)])))}
          >
            CSV
          </Button>
        }
      >
        {rows === null ? <Loading /> : rows.length === 0 ? <Nothing>No record was opened in this period.</Nothing> : null}
        <ul className="flex flex-col">
          {(rows ?? []).map((r) => (
            <li key={r.id} className="border-b border-cream-100 py-1.5 text-sm" data-testid="health-access-row">
              <p className="flex flex-wrap items-center gap-1.5">
                <Badge tone={r.action === "BREAK_GLASS" ? "danger" : r.action.startsWith("CONSENT") ? "info" : "neutral"}>{r.action.replace(/_/g, " ").toLowerCase()}</Badge>
                <strong>{r.actorLabel}</strong>
                <span className="text-xs text-ink-600">({r.actorRole.toLowerCase()})</span>
                <span className="text-xs">
                  {r.objectType} · patient <span className="font-mono">{r.patient}</span> <span className="font-mono text-ink-500">{r.patientId.slice(0, 8)}</span>
                </span>
              </p>
              <p className="text-xs text-ink-600">
                {ist(r.at)}
                {reasonText(r) ? ` · ${reasonText(r)}` : ""}
              </p>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel
        title="Health audit trail"
        action={
          <Button size="sm" variant="secondary" disabled={!audit?.length} onClick={() => downloadText("health-audit.csv", toCsv(["Time (IST)", "Action", "By", "Role", "Entity", "Entity id", "Change"], (audit ?? []).map((a) => [ist(a.at), a.action, a.actor, a.actorRole, a.entityType, a.entityId, a.change])))}>
            CSV
          </Button>
        }
      >
        {audit === null ? <Loading /> : audit.length === 0 ? <Nothing>No health changes in this period.</Nothing> : null}
        <ul className="flex flex-col">
          {(audit ?? []).map((a) => (
            <li key={a.id} className="border-b border-cream-100 py-1.5 text-sm" data-testid="health-audit-row">
              <p className="flex flex-wrap items-center gap-1.5">
                <Badge tone={a.action === "health.break_glass" ? "danger" : "neutral"}>{a.action}</Badge>
                <strong>{a.actor}</strong>
                {a.actorRole ? <span className="text-xs text-ink-600">({a.actorRole.toLowerCase()})</span> : null}
                <span className="text-xs">
                  {a.entityType} <span className="font-mono text-ink-500">{a.entityId?.slice(0, 8)}</span>
                </span>
              </p>
              <p className="break-all text-xs text-ink-600">
                {ist(a.at)}
                {a.change ? ` · ${a.change}` : ""}
              </p>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
