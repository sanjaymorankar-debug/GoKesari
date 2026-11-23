"use client";

/**
 * docs/delta CF-006: riders ask to join a society; the society admin approves or declines.
 *   RiderSocietyJoin       — rider: find a verified society, ask to join, see and withdraw requests
 *   SocietyJoinRequestsPanel — society page: pending requests, approve / decline (ADMIN only)
 * Both are rendered only while the flag society_rider_join_requests_enabled is on (the pages decide).
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, StatusBadge, inputClass } from "@/components/ui";

type SocietyHit = { id: string; name: string; area: string | null; city: string; pincode: string };
type MyRequest = {
  id: string;
  societyId: string;
  societyName: string;
  area: string | null;
  city: string;
  status: string;
  decisionNote: string | null;
  createdAt: string;
};

async function send(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? "Something went wrong. Please try again.");
  return body;
}

export function RiderSocietyJoin({ initialRequests }: { initialRequests: MyRequest[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SocietyHit[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingIds = new Set(initialRequests.filter((r) => r.status === "PENDING").map((r) => r.societyId));

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("search");
    try {
      const res = await fetch(`/api/societies?q=${encodeURIComponent(query.trim())}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not search societies.");
      setHits(Array.isArray(body) ? body : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not search societies.");
    } finally {
      setBusy(null);
    }
  }

  async function ask(society: SocietyHit) {
    setError(null);
    setNotice(null);
    setBusy(society.id);
    try {
      await send(`/api/societies/${society.id}/join-requests`, {
        method: "POST",
        body: JSON.stringify({ message: message.trim() || null }),
      });
      setNotice(`Request sent to ${society.name}. You'll be told when they decide.`);
      setMessage("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the request.");
    } finally {
      setBusy(null);
    }
  }

  async function withdraw(id: string) {
    setError(null);
    setNotice(null);
    setBusy(id);
    try {
      await send(`/api/societies/join-requests/${id}`, { method: "PATCH", body: JSON.stringify({ action: "withdraw" }) });
      setNotice("Request withdrawn.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not withdraw the request.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6" data-testid="rider-society-join">
      <Card className="p-4">
        <h2 className="text-lg font-semibold text-ink-900">Find a society</h2>
        <p className="mt-1 text-sm text-ink-600">
          Ask a housing society to add you to its rider list. Listed riders are offered its residents&apos; deliveries first.
        </p>
        <form onSubmit={search} className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field label="Society name, area or PIN code">
              <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} maxLength={80} />
            </Field>
          </div>
          <Button type="submit" disabled={busy !== null}>
            {busy === "search" ? "Searching…" : "Search"}
          </Button>
        </form>
        {hits ? (
          hits.length === 0 ? (
            <p className="mt-4 text-sm text-ink-500">No verified society found. Try another name or the PIN code.</p>
          ) : (
            <div className="mt-4 space-y-3">
              <Field label="Note to the society (optional)" hint="For example, when you usually deliver in this area.">
                <input className={inputClass} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} />
              </Field>
              <ul className="divide-y divide-cream-100 rounded-lg border border-cream-200">
                {hits.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                    <span>
                      {s.name}
                      <span className="text-xs text-ink-500"> · {[s.area, s.city, s.pincode].filter(Boolean).join(", ")}</span>
                    </span>
                    {pendingIds.has(s.id) ? (
                      <span className="text-xs text-ink-500">Request pending</span>
                    ) : (
                      <Button variant="secondary" onClick={() => void ask(s)} disabled={busy !== null}>
                        {busy === s.id ? "Sending…" : "Ask to join"}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : null}
      </Card>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card className="p-4">
        <h2 className="text-lg font-semibold text-ink-900">My requests</h2>
        {initialRequests.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">You haven&apos;t asked any society yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-cream-100" data-testid="my-society-requests">
            {initialRequests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <span>
                  {r.societyName}
                  <span className="text-xs text-ink-500"> · {[r.area, r.city].filter(Boolean).join(", ")}</span>
                  {r.decisionNote ? <span className="block text-xs text-ink-500">“{r.decisionNote}”</span> : null}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  {r.status === "PENDING" ? (
                    <Button variant="ghost" onClick={() => void withdraw(r.id)} disabled={busy !== null}>
                      {busy === r.id ? "Withdrawing…" : "Withdraw"}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

type PendingRequest = {
  id: string;
  riderName: string;
  vehicleType: string | null;
  ratingAvgX100: number | null;
  ratingCount: number;
  message: string | null;
};

export function SocietyJoinRequestsPanel({ requests, canDecide }: { requests: PendingRequest[]; canDecide: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, action: "approve" | "decline") {
    setError(null);
    setBusy(id);
    try {
      await send(`/api/societies/join-requests/${id}`, { method: "PATCH", body: JSON.stringify({ action }) });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the decision.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="society-join-requests">
      {error ? (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      {requests.length === 0 ? (
        <p className="text-sm text-ink-500">No rider has asked to join.</p>
      ) : (
        <Card className="divide-y divide-cream-100">
          {requests.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <span>
                {r.riderName}
                <span className="text-xs text-ink-500">
                  {r.vehicleType ? ` · ${r.vehicleType.toLowerCase()}` : ""}
                  {r.ratingCount > 0 && r.ratingAvgX100 !== null ? ` · ★ ${(r.ratingAvgX100 / 100).toFixed(1)} (${r.ratingCount})` : ""}
                </span>
                {r.message ? <span className="block text-xs text-ink-500">“{r.message}”</span> : null}
              </span>
              {canDecide ? (
                <span className="flex gap-2">
                  <Button onClick={() => void decide(r.id, "approve")} disabled={busy !== null}>
                    {busy === r.id ? "Saving…" : "Approve"}
                  </Button>
                  <Button variant="secondary" onClick={() => void decide(r.id, "decline")} disabled={busy !== null}>
                    Decline
                  </Button>
                </span>
              ) : (
                <span className="text-xs text-ink-500">Waiting for the society admin</span>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
