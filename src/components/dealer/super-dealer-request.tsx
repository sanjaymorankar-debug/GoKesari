"use client";
/**
 * Owner, 28-Nov-2026: "Become a super dealer" — the dealer's own request; an admin or operator approves it.
 * Reads and posts /api/dealer/super-request. Shows nothing for an account that cannot ask (not a dealer, closed,
 * or in a super dealer's team).
 */
import { useEffect, useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";

type State = { status: "NOT_A_DEALER" | "CLOSED" | "IN_TEAM" | "SUPER" | "PENDING" | "AFTER_DEALER_APPROVAL" | "CAN_REQUEST"; requestedAt: string | null };

export function SuperDealerRequest({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/dealer/super-request")
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => live && p && setState(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dealer/super-request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      const p = await res.json().catch(() => null);
      if (!res.ok) throw new Error(p?.error?.message ?? "Something went wrong. Please try again.");
      setState(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (!state || state.status === "NOT_A_DEALER" || state.status === "CLOSED" || state.status === "IN_TEAM") return null;
  const body =
    state.status === "SUPER" ? (
      <Badge tone="success">Super dealer</Badge>
    ) : state.status === "PENDING" ? (
      <p className="text-sm text-ink-700">
        <Badge tone="info">Request sent</Badge> Your request to become a super dealer is with GoKesari; an admin or operator approves it.
      </p>
    ) : state.status === "AFTER_DEALER_APPROVAL" ? (
      <p className="text-sm text-ink-700">
        <Badge tone="info">Noted</Badge> You asked to become a super dealer. The request goes to GoKesari as soon as you are approved as a dealer.
      </p>
    ) : (
      <div className="space-y-2">
        <p className="text-sm text-ink-700">A super dealer leads a team of dealers and earns extra on his team&apos;s business, paid by GoKesari on top. An admin or operator approves the request.</p>
        <Button size="sm" variant="secondary" onClick={() => void ask()} disabled={busy} data-testid="super-dealer-request-go">
          {busy ? "Please wait…" : "Request to become a super dealer"}
        </Button>
      </div>
    );
  if (compact) return <div data-testid="super-dealer-request">{body}{error ? <Alert tone="danger">{error}</Alert> : null}</div>;
  return (
    <Card className="space-y-2 p-4" data-testid="super-dealer-request">
      <h2 className="text-base font-bold text-ink-900">Super dealer</h2>
      {body}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}
