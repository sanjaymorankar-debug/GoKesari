"use client";
/**
 * Admin → Franchise → Zone status (§5.6): change one zone or many (with a reason), Reserved for a named dealer until
 * an IST date, or scheduled for a future IST moment; Sold Out is the system's only. History with cancel for pending
 * scheduled changes. Operators read only.
 */
import { useState } from "react";

import { Badge, Button, Card, inputClass } from "@/components/ui";
import { ZONE_STATUS_LABELS, formatIst } from "@/lib/franchise";

import { STATUS_TONE, call, istInputToIso, type Act, type AdminZone, type StatusHistoryRow } from "./shared";

const SETTABLE = ["AVAILABLE", "COMING_SOON", "RESERVED", "ON_HOLD", "INACTIVE"] as const;

export function StatusTab({ zones, history, isAdmin, act }: { zones: AdminZone[]; history: StatusHistoryRow[]; isAdmin: boolean; act: Act }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [status, setStatus] = useState<(typeof SETTABLE)[number]>("AVAILABLE");
  const [reason, setReason] = useState("");
  const [dealerId, setDealerId] = useState("");
  const [until, setUntil] = useState("");
  const [when, setWhen] = useState("");
  const [filter, setFilter] = useState("ALL");
  const list = zones.filter((z) => filter === "ALL" || z.status === filter);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const submit = () =>
    act(
      () =>
        call("/api/admin/franchise/zones/status", "POST", {
          zoneIds: picked,
          status,
          reason,
          reservedForDealerId: status === "RESERVED" ? dealerId.trim() || null : null,
          reservedUntil: status === "RESERVED" ? istInputToIso(until) : null,
          scheduledFor: istInputToIso(when),
        }).then((r) => {
          setPicked([]);
          return r;
        }),
      when ? `Scheduled for ${picked.length} zone(s)` : `Status changed for ${picked.length} zone(s); owners and the CEO copy list are told`,
    );
  const pending = history.filter((h) => h.scheduledFor && !h.appliedAt && !h.cancelledAt);
  return (
    <Card className="space-y-3 p-4" data-testid="admin-zone-status">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-ink-700">
          Show{" "}
          <select className={inputClass} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="ALL">All statuses</option>
            {Object.entries(ZONE_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {isAdmin ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setPicked(list.map((z) => z.zoneId))}>
              Select shown
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked([])}>
              Clear
            </Button>
          </>
        ) : null}
      </div>
      <div className="grid max-h-80 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
        {list.map((z) => (
          <label key={z.zoneId} className="flex items-center gap-2 rounded border border-cream-100 px-2 py-1 text-sm">
            {isAdmin ? <input type="checkbox" checked={picked.includes(z.zoneId)} onChange={() => toggle(z.zoneId)} /> : null}
            <span className="font-semibold">{z.zoneId}</span>
            <span className="truncate">{z.name}</span>
            <Badge tone={STATUS_TONE[z.status] ?? "neutral"}>{z.statusLabel}</Badge>
            {z.status === "RESERVED" && z.reservedUntil ? <span className="text-xs text-ink-500">to {formatIst(z.reservedUntil)}</span> : null}
          </label>
        ))}
      </div>
      {isAdmin ? (
        <div className="space-y-2 rounded-lg border border-cream-200 p-3">
          <p className="text-sm font-semibold text-ink-900">Change status of {picked.length} zone(s)</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm text-ink-700">
              New status
              <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as (typeof SETTABLE)[number])}>
                {SETTABLE.map((s) => (
                  <option key={s} value={s}>
                    {ZONE_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-ink-700">
              Reason (required, logged)
              <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            {status === "RESERVED" ? (
              <>
                <label className="text-sm text-ink-700">
                  Reserved for dealer (dealer id)
                  <input className={inputClass} value={dealerId} onChange={(e) => setDealerId(e.target.value)} placeholder="uuid" />
                </label>
                <label className="text-sm text-ink-700">
                  Reservation expires (IST)
                  <input className={inputClass} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
                </label>
              </>
            ) : null}
            <label className="text-sm text-ink-700">
              Schedule for (IST, optional — blank = now)
              <input className={inputClass} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </label>
          </div>
          <p className="text-xs text-ink-600">Sold Out is set and cleared by the system. Status changes never change an active franchise&apos;s fee, term or earned commission. Inactive hides the zone and blocks renewal; running terms continue.</p>
          <Button onClick={submit} disabled={!picked.length || reason.trim().length < 5}>
            {when ? "Schedule change" : "Apply now"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-ink-600">Read only: only an admin can change a zone&apos;s status.</p>
      )}
      {pending.length ? (
        <>
          <h3 className="font-semibold text-ink-900">Scheduled (not yet applied)</h3>
          <ul className="space-y-1 text-sm">
            {pending.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2">
                {h.zoneId} → {ZONE_STATUS_LABELS[h.newStatus as keyof typeof ZONE_STATUS_LABELS] ?? h.newStatus} at {formatIst(h.scheduledFor)} · {h.reason}
                {isAdmin ? (
                  <Button size="sm" variant="ghost" onClick={() => act(() => call(`/api/admin/franchise/zones/status?id=${h.id}`, "DELETE"), "Scheduled change cancelled")}>
                    Cancel
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3 className="font-semibold text-ink-900">Status history</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="text-left text-ink-500">
            <tr>
              <th>When (IST)</th>
              <th>Zone</th>
              <th>From</th>
              <th>To</th>
              <th>Reason</th>
              <th>By</th>
              <th>Scheduled</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id} className="border-t border-cream-100">
                <td>{formatIst(h.appliedAt ?? h.createdAt)}</td>
                <td>{h.zoneId}</td>
                <td>{h.oldStatus ?? "—"}</td>
                <td>{h.newStatus}</td>
                <td>{h.reason}</td>
                <td>{h.changedBy ?? "system"}</td>
                <td>{h.scheduledFor ? `${formatIst(h.scheduledFor)}${h.cancelledAt ? " (cancelled)" : h.appliedAt ? "" : " (pending)"}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
