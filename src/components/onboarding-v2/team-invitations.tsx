"use client";

/** The invited person's accept / decline buttons (docs/onboarding-v2-2026-11, Flow 4). Talks to /api/team/invitations. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card } from "@/components/ui";
import { TEAM_ROLE_LABEL } from "@/lib/onboarding-v2/team";
import type { InvitationView } from "@/server/onboarding-v2/team";

export function TeamInvitations({ invitations }: { invitations: InvitationView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);

  async function respond(id: string, action: "accept" | "decline") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/team/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, invitationId: id }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      if (action === "accept") setJoined(id);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="team-invitations">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {joined ? (
        <Alert tone="success" title="You have joined the team">
          Your code and earnings are on your <Link className="font-semibold underline" href="/dealer">dealer page</Link>. Add your PAN and payout bank account there before the first payout.
        </Alert>
      ) : null}
      {invitations.length === 0 && !joined ? <p className="text-sm text-ink-600">No team requests are waiting for you.</p> : null}
      {invitations.map((i) => (
        <Card key={i.id} className="space-y-2 p-4">
          <p className="font-semibold text-ink-900">{i.dealerName}</p>
          <p className="text-sm text-ink-700">
            asks you to join as <span className="font-medium">{TEAM_ROLE_LABEL[i.role]}</span>
            {i.role === "AGENT" ? ` reporting to ${i.parentName ?? "the dealer"}` : " reporting to the dealer"}. Sent by {i.invitedBy} on {i.createdIst}; valid until {i.expiresIst}.
          </p>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => respond(i.id, "accept")}>Accept</Button>
            <Button variant="secondary" disabled={busy} onClick={() => respond(i.id, "decline")}>Decline</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
