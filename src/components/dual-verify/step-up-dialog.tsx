"use client";

import { useEffect, useState } from "react";

import { postJson } from "./api";
import { CodeInput } from "./code-input";

export interface StepUpRequest {
  action: string;
  actionLabel?: string | null;
  maskedPhone?: string | null;
  maskedEmail?: string | null;
}

const buttonClass =
  "min-h-11 rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800 disabled:bg-cream-200 disabled:text-ink-600";

/**
 * docs/dual-auth-2026-11: the two codes of a sensitive action (mobile / e-mail change, bank or payout account,
 * withdrawal, team role, ownership). Sends a code by SMS and one by e-mail, checks both, then `onDone(true)` so the
 * caller retries what it was doing. Resend after the cooldown the server gives.
 */
export function DualStepUpDialog({ request, onDone }: { request: StepUpRequest; onDone: (verified: boolean) => void }) {
  const [sent, setSent] = useState<{ maskedPhone: string; maskedEmail: string; resendAfterSeconds: number } | null>(null);
  const [smsCode, setSmsCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function send() {
    setBusy(true);
    setError(null);
    const res = await postJson<{ maskedPhone: string; maskedEmail: string; resendAfterSeconds: number }>("/api/dual-auth/step-up", { action: "start", sensitive: request.action });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      const verifyUrl = res.details?.verifyUrl;
      if (typeof verifyUrl === "string") window.location.assign(verifyUrl);
      return;
    }
    setSent(res.data);
    setResendAt(Date.now() + res.data.resendAfterSeconds * 1000);
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (smsCode.length < 4 || emailCode.length < 4) return setError("Enter both codes.");
    setBusy(true);
    setError(null);
    const res = await postJson("/api/dual-auth/step-up", { action: "verify", sensitive: request.action, smsCode, emailCode });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    onDone(true);
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="dual-step-up-title" className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" data-testid="dual-step-up">
      <div className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl">
        <h2 id="dual-step-up-title" className="text-lg font-semibold text-ink-900">
          Confirm it&apos;s you
        </h2>
        <p className="mt-1 text-sm text-ink-600">
          To {request.actionLabel ?? "do this"}, enter a code from your mobile (SMS) <strong>and</strong> a code from your e-mail.
        </p>
        {!sent ? (
          <div className="mt-4 space-y-2 text-sm text-ink-700">
            <p>
              We will send one code by SMS to <strong>{request.maskedPhone ?? "your mobile"}</strong> and one to <strong>{request.maskedEmail ?? "your e-mail"}</strong>.
            </p>
            <button type="button" className={buttonClass} disabled={busy} onClick={send} data-testid="dual-step-up-send">
              {busy ? "Sending…" : "Send the two codes"}
            </button>
          </div>
        ) : (
          <form onSubmit={verify} className="mt-4 space-y-3">
            <label className="block text-sm text-ink-700">
              SMS code sent to <strong>{sent.maskedPhone}</strong>
              <div className="mt-1 flex">
                <CodeInput value={smsCode} onChange={setSmsCode} label="SMS code" sms autoFocus testId="dual-step-up-sms" />
              </div>
            </label>
            <label className="block text-sm text-ink-700">
              E-mail code sent to <strong>{sent.maskedEmail}</strong>
              <div className="mt-1 flex">
                <CodeInput value={emailCode} onChange={setEmailCode} label="E-mail code" testId="dual-step-up-email" />
              </div>
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className={buttonClass} disabled={busy} data-testid="dual-step-up-verify">
                {busy ? "Checking…" : "Confirm"}
              </button>
              <button type="button" className="text-xs underline disabled:no-underline disabled:opacity-50" disabled={busy || now < resendAt} onClick={send}>
                {now < resendAt ? `Resend codes in ${Math.ceil((resendAt - now) / 1000)}s` : "Resend codes"}
              </button>
            </div>
          </form>
        )}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <button type="button" className="mt-4 text-xs underline" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
