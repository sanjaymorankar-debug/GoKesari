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
  /** docs/flows-v3/wave5.md (flag flow_f18): a second code goes by SMS to this mobile (masked). */
  maskedPhone?: string | null;
  /** docs/flows-v3/wave5.md (flag flow_f18): shops closed with the account. */
  shopsToHide?: number;
  /** 0199: the reasons offered (a reason is required); "OTHER" needs words. */
  reasons: readonly { code: string; label: string }[];
  /** 0199: days the account stays hidden before it is deleted (rule accountDeletion.coolingOffDays). */
  coolingOffDays: number;
}

/**
 * docs/account-deletion-2026-11: the steps on /profile/delete — blockers (with
 * where to fix each), then the emailed code, the reason (required) and the typed
 * word DELETE, then the "account hidden, deleted on <date>" screen (0199 cooling-off).
 */
export function AccountDeletionFlow(props: AccountDeletionFlowProps) {
  const [blockers, setBlockers] = useState(props.blockers);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // docs/flows-v3/wave5.md (flag flow_f18): a second code, by SMS, when the server sent one.
  const [smsSentTo, setSmsSentTo] = useState<string | null>(null);
  const [smsCode, setSmsCode] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletedOn, setDeletedOn] = useState<string | null>(null);

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
    setSmsSentTo(typeof payload.maskedPhone === "string" ? payload.maskedPhone : null);
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (confirmText.trim() !== "DELETE") return setError("Type DELETE in capital letters to confirm.");
    if (!reasonCode) return setError("Tell us why you are leaving: pick a reason.");
    if (reasonCode === "OTHER" && reason.trim().length < 3) return setError("Tell us in a few words why you are leaving.");
    setBusy(true);
    const res = await fetch("/api/profile/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, confirmText: confirmText.trim(), reasonCode, reason: reason.trim() || null, ...(smsSentTo ? { smsCode } : {}) }),
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
    setDeletedOn(
      new Date(payload.purgeAfter).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }),
    );
  }

  if (deletedOn) {
    return (
      <Card className="p-6" data-testid="account-deleted">
        <h2 className="text-lg font-semibold text-ink-900">Your account is now hidden</h2>
        <p className="mt-2 text-sm text-ink-700">
          It will be deleted permanently on <strong>{deletedOn}</strong>. You have been signed out on every device, and a
          confirmation has been sent to your email address.
        </p>
        <p className="mt-2 text-sm text-ink-700">
          Changed your mind? Until then, sign in with your email address and the code we send you, and choose “Restore my
          account”.
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
          {props.shopsToHide ? (
            <Alert tone="warning">
              Your {props.shopsToHide === 1 ? "shop" : `${props.shopsToHide} shops`} will be closed and hidden with your account.
              Money owed to the shop is still settled as usual.
            </Alert>
          ) : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}

          {!sentTo ? (
            <div>
              <p className="mb-3 text-sm text-ink-700">
                We will email a code to {props.maskedEmail ?? "your email address"}
                {props.maskedPhone ? ` and send one by SMS to ${props.maskedPhone}` : ""} to make sure it is you.
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
              {smsSentTo ? (
                <Field label={`Code sent by SMS to ${smsSentTo}`}>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={smsCode}
                    onChange={(e) => setSmsCode(e.target.value)}
                    required
                    data-testid="account-delete-sms-code"
                  />
                </Field>
              ) : null}
              <Field label="Why are you leaving?">
                <select className={inputClass} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} required>
                  <option value="">Pick a reason</option>
                  {props.reasons.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={reasonCode === "OTHER" ? "Your reason" : "Anything to add? (optional)"}>
                <textarea
                  className={inputClass}
                  rows={2}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required={reasonCode === "OTHER"}
                />
              </Field>
              <Field
                label="Type DELETE to confirm"
                hint={`Your account is hidden at once and deleted after ${props.coolingOffDays} days. Sign in during that time to restore it.`}
              >
                <input
                  className={inputClass}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoCapitalize="characters"
                  required
                />
              </Field>
              <div>
                <Button type="submit" variant="danger" disabled={busy || confirmText.trim() !== "DELETE" || !code.trim() || (smsSentTo !== null && !smsCode.trim()) || !reasonCode}>
                  {busy ? "Deleting…" : "Delete my account"}
                </Button>
              </div>
            </form>
          )}
        </Card>
      ) : null}
    </div>
  );
}
