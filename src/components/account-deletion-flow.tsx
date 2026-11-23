"use client";

import Link from "next/link";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { signOutAction } from "@/server/sign-out-action";

export interface DeletionBlockerView {
  code: string;
  message: string;
  count?: number;
  href?: string;
}

export interface AccountDeletionFlowProps {
  canDelete: boolean;
  blockers: DeletionBlockerView[];
  subscriptionsToCancel: number;
  /** Already formatted (₹). Null when there is no promotional credit. */
  promotionalForfeit: string | null;
  maskedEmail: string | null;
}

/**
 * docs/account-deletion-2026-11: the steps on /profile/delete — blockers (with
 * where to fix each), then the emailed code and the typed word DELETE, then the
 * signed-out "account deleted" screen.
 */
export function AccountDeletionFlow(props: AccountDeletionFlowProps) {
  const [blockers, setBlockers] = useState(props.blockers);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  function readBlockers(payload: unknown): DeletionBlockerView[] | null {
    const details = (payload as { error?: { details?: { blockers?: DeletionBlockerView[] } } } | null)?.error?.details;
    return Array.isArray(details?.blockers) ? details.blockers : null;
  }

  async function sendCode() {
    setError(null);
    setBusy(true);
    const res = await fetch("/api/profile/delete/code", { method: "POST" });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      const found = readBlockers(payload);
      if (found) setBlockers(found);
      return setError(payload?.error?.message ?? "Could not send the code.");
    }
    setSentTo(payload.maskedEmail);
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (confirmText.trim() !== "DELETE") return setError("Type DELETE in capital letters to confirm.");
    setBusy(true);
    const res = await fetch("/api/profile/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, confirmText: confirmText.trim(), reason: reason.trim() || null }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      const found = readBlockers(payload);
      if (found) {
        setBlockers(found);
        setSentTo(null);
      }
      return setError(payload?.error?.message ?? "Could not delete the account.");
    }
    setDeleted(true);
  }

  if (deleted) {
    return (
      <Card className="p-6" data-testid="account-deleted">
        <h2 className="text-lg font-semibold text-ink-900">Your account has been deleted</h2>
        <p className="mt-2 text-sm text-ink-700">
          You have been signed out on every device. A confirmation has been sent to your old email address.
        </p>
        <p className="mt-2 text-sm text-ink-700">
          You can create a new account with the same email address at any time — it starts empty.
        </p>
        <form action={signOutAction} className="mt-4">
          <Button type="submit">Go to the home page</Button>
        </form>
      </Card>
    );
  }

  return (
    <div className="grid gap-6">
      {blockers.length > 0 ? (
        <Card className="p-6" data-testid="account-deletion-blockers">
          <h2 className="text-base font-semibold text-ink-900">Before you can delete your account</h2>
          <ul className="mt-3 grid gap-3 text-sm">
            {blockers.map((b) => (
              <li key={b.code} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                <p>{b.message}</p>
                {b.href ? (
                  <Link href={b.href} className="mt-1 inline-block font-medium text-kesari-700 hover:underline">
                    Go there →
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-500">Reload this page once these are sorted out.</p>
        </Card>
      ) : null}

      {blockers.length === 0 ? (
        <Card className="grid gap-4 p-6" data-testid="account-deletion-confirm">
          <h2 className="text-base font-semibold text-ink-900">Confirm deletion</h2>
          {props.subscriptionsToCancel > 0 ? (
            <Alert tone="warning">
              Your {props.subscriptionsToCancel === 1 ? "subscription" : `${props.subscriptionsToCancel} subscriptions`} will be
              cancelled automatically. No further deliveries will be made or charged.
            </Alert>
          ) : null}
          {props.promotionalForfeit ? (
            <Alert tone="warning">
              Promotional credit of {props.promotionalForfeit} in your wallet cannot be withdrawn and will lapse.
            </Alert>
          ) : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}

          {!sentTo ? (
            <div>
              <p className="mb-3 text-sm text-ink-700">
                We will email a code to {props.maskedEmail ?? "your email address"} to make sure it is you.
              </p>
              <Button type="button" variant="danger" disabled={busy} onClick={sendCode}>
                {busy ? "Sending…" : "Email me the code"}
              </Button>
            </div>
          ) : (
            <form onSubmit={confirm} className="grid gap-4">
              <p className="text-sm text-ink-700">
                We sent a code to <strong>{sentTo}</strong>.{" "}
                <button type="button" className="text-kesari-700 underline" disabled={busy} onClick={sendCode}>
                  Send a new code
                </button>
              </p>
              <Field label="Code from the email">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </Field>
              <Field label="Why are you leaving? (optional)">
                <textarea className={inputClass} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <Field label='Type DELETE to confirm' hint="This cannot be undone.">
                <input
                  className={inputClass}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoCapitalize="characters"
                  required
                />
              </Field>
              <div>
                <Button type="submit" variant="danger" disabled={busy || confirmText.trim() !== "DELETE" || !code.trim()}>
                  {busy ? "Deleting…" : "Delete my account permanently"}
                </Button>
              </div>
            </form>
          )}
        </Card>
      ) : null}
    </div>
  );
}
