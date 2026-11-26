"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";

export interface SosRowView {
  id: string;
  status: "OPEN" | "ACKNOWLEDGED" | "CLOSED";
  raisedAt: string;
  acknowledgedAt: string | null;
  closedAt: string | null;
  note: string | null;
  riderName: string;
  riderMobile: string;
  emergencyContact: string | null;
  emergencyContactMobile: string | null;
  orderNumber: string | null;
  mapUrl: string | null;
  accuracyM: number | null;
}

const FILTERS = [
  { key: null, label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "ACKNOWLEDGED", label: "Acknowledged" },
  { key: "CLOSED", label: "Closed" },
] as const;

const TONE = { OPEN: "danger", ACKNOWLEDGED: "warning", CLOSED: "neutral" } as const;

export function RiderSosQueue({ events, status }: { events: SosRowView[]; status: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function act(id: string, action: "acknowledge" | "close") {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/rider-sos/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: action === "close" ? JSON.stringify({ note }) : "{}",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not update the SOS.");
      setClosing(null);
      setNote("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the SOS.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <nav className="flex flex-wrap gap-2" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <Link
            key={f.label}
            href={f.key ? `/admin/rider-sos?status=${f.key}` : "/admin/rider-sos"}
            className={`rounded-full border px-3 py-1 text-sm ${status === f.key ? "border-kesari-600 bg-kesari-50 text-kesari-800" : "border-cream-200 text-ink-700"}`}
          >
            {f.label}
          </Link>
        ))}
        <Button variant="ghost" size="sm" onClick={() => router.refresh()}>
          Refresh
        </Button>
      </nav>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {events.length === 0 ? (
        <EmptyState title="No SOS alerts" description="Alerts riders raise appear here at once, open ones first." />
      ) : (
        events.map((e) => (
          <Card key={e.id} className="space-y-2 p-4 text-sm" data-testid="rider-sos-row">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-ink-900">
                {e.riderName} · <a href={`tel:${e.riderMobile}`} className="text-kesari-700 underline">{e.riderMobile}</a>
              </p>
              <Badge tone={TONE[e.status]}>{e.status.toLowerCase()}</Badge>
            </div>
            <p className="text-ink-600">
              Raised {e.raisedAt}
              {e.acknowledgedAt ? ` · acknowledged ${e.acknowledgedAt}` : ""}
              {e.closedAt ? ` · closed ${e.closedAt}` : ""}
            </p>
            <p className="text-ink-700">
              Order: {e.orderNumber ?? "none in progress"} ·{" "}
              {e.mapUrl ? (
                <a href={e.mapUrl} target="_blank" rel="noopener noreferrer" className="text-kesari-700 underline">
                  Open map{e.accuracyM != null ? ` (±${e.accuracyM} m)` : ""}
                </a>
              ) : (
                "location not shared"
              )}
            </p>
            {e.emergencyContactMobile ? (
              <p className="text-ink-700">
                Emergency contact: {e.emergencyContact} ·{" "}
                <a href={`tel:${e.emergencyContactMobile}`} className="text-kesari-700 underline">
                  {e.emergencyContactMobile}
                </a>
              </p>
            ) : null}
            {e.note ? <p className="whitespace-pre-line rounded bg-cream-100 p-2 text-ink-700">Note: {e.note}</p> : null}
            {e.status !== "CLOSED" ? (
              closing === e.id ? (
                <div className="space-y-2">
                  <textarea
                    className={inputClass}
                    rows={2}
                    maxLength={2000}
                    placeholder="What happened and what was done"
                    value={note}
                    onChange={(ev) => setNote(ev.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy === e.id || note.trim().length < 3} onClick={() => act(e.id, "close")}>
                      Close SOS
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setClosing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {e.status === "OPEN" ? (
                    <Button size="sm" variant="danger" disabled={busy === e.id} onClick={() => act(e.id, "acknowledge")}>
                      Acknowledge
                    </Button>
                  ) : null}
                  <Button size="sm" variant="secondary" disabled={busy === e.id} onClick={() => setClosing(e.id)}>
                    Close…
                  </Button>
                </div>
              )
            ) : null}
          </Card>
        ))
      )}
    </div>
  );
}
