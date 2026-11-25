"use client";

import { useEffect, useState } from "react";

import { parseIndianMobile } from "@/lib/contact";
import type { SecondFactorPrompt } from "@/server/otp/second-factor";
import { sendSignInSmsCode, verifySignInSmsCode } from "@/server/signin-second-factor-action";

const inputClass =
  "min-w-0 rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none";
const buttonClass =
  "min-h-11 rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800 disabled:bg-cream-200 disabled:text-ink-600";

/**
 * docs/sms-2fa-2026-11: the second sign-in step — a code sent by SMS to the
 * account's verified mobile, or (none yet) to the number entered here, which
 * is then saved as verified. The session opens only after this code.
 */
export function SmsSecondFactor({ prompt, onCancel }: { prompt: SecondFactorPrompt; onCancel?: () => void }) {
  const [needsNumber, setNeedsNumber] = useState(prompt.needsPhone);
  const [mobileInput, setMobileInput] = useState("");
  const [mobile, setMobile] = useState<string | null>(null);
  const [maskedPhone, setMaskedPhone] = useState<string | null>(prompt.maskedPhone);
  const [codeSent, setCodeSent] = useState(!prompt.needsPhone && !prompt.sendError);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(prompt.sendError);
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(() => (prompt.resendAfterSeconds ? Date.now() + prompt.resendAfterSeconds * 1000 : 0));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!resendAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [resendAt]);

  async function send(number: string | null) {
    setBusy(true);
    setError(null);
    const result = await sendSignInSmsCode({ challenge: prompt.challenge, mobile: number });
    setBusy(false);
    if (result.error !== undefined) {
      setError(result.error);
      if (result.needsPhone) setNeedsNumber(true);
      return;
    }
    setMobile(number);
    setMaskedPhone(result.maskedPhone);
    setCodeSent(true);
    setNeedsNumber(false);
    setResendAt(Date.now() + result.resendAfterSeconds * 1000);
    setNow(Date.now());
    setCode("");
  }

  function submitNumber(event: React.FormEvent) {
    event.preventDefault();
    const parsed = parseIndianMobile(mobileInput);
    if (!parsed.ok) return setError(parsed.error);
    void send(parsed.national);
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{4,8}$/.test(code.trim())) return setError("Enter the code we sent you by SMS.");
    setBusy(true);
    setError(null);
    // On success the server function opens the session and redirects; it never returns here.
    const result = await verifySignInSmsCode({ challenge: prompt.challenge, mobile, code: code.trim() });
    if (result?.error) setError(result.error);
    setBusy(false);
  }

  return (
    <div data-testid="sms-second-factor">
      <p className="mb-2 text-sm font-medium text-ink-700">Step 2 of 2: confirm with an SMS code</p>
      {needsNumber ? (
        <form onSubmit={submitNumber}>
          <p className="mb-2 text-sm text-ink-600">
            Your email code is right. Now add your mobile number: we send a code there by SMS, and save the number on your account once you enter it.
          </p>
          <div className="flex gap-2">
            <input
              value={mobileInput}
              onChange={(e) => setMobileInput(e.target.value)}
              inputMode="tel"
              autoComplete="tel-national"
              placeholder="10-digit mobile number"
              aria-label="Mobile number for the SMS code"
              className={`${inputClass} min-h-11 flex-1 text-base`}
              required
            />
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? "Sending…" : "Send SMS code"}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={submitCode}>
          <p className="mb-2 text-sm text-ink-600" data-testid="sms-sent-to">
            {codeSent ? (
              <>
                Your email code is right. We sent a code by SMS to <strong>{maskedPhone}</strong>.
              </>
            ) : (
              <>Your email code is right. Press Resend to get a code by SMS on {maskedPhone}.</>
            )}
          </p>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="SMS code"
              aria-label="SMS code"
              maxLength={8}
              className={`${inputClass} flex-1 tracking-widest`}
              required
            />
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? "Checking…" : "Verify and sign in"}
            </button>
          </div>
          <div className="mt-2 flex gap-3 text-xs">
            <button
              type="button"
              className="underline disabled:no-underline disabled:opacity-50"
              disabled={busy || now < resendAt}
              onClick={() => send(mobile)}
            >
              {now < resendAt ? `Resend SMS in ${Math.ceil((resendAt - now) / 1000)}s` : "Resend SMS"}
            </button>
            {prompt.needsPhone ? (
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setNeedsNumber(true);
                  setError(null);
                }}
              >
                Use a different number
              </button>
            ) : null}
          </div>
        </form>
      )}
      {onCancel ? (
        <button type="button" className="mt-2 text-xs underline" onClick={onCancel}>
          Start again
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
