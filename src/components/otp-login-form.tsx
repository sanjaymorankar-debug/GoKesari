"use client";

import { useEffect, useState } from "react";

import { ConsentHint, useSharedConsent } from "@/components/sign-in-consent";
import { EMAIL_HINT, isValidEmail, parseIndianMobile } from "@/lib/contact";

type Step = "identify" | "email" | "code";
export type VerifyLoginCode = (input: {
  mobile: string | null;
  email: string | null;
  code: string;
}) => Promise<{ error?: string } | void>;

const inputClass =
  "min-w-0 rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none";
const buttonClass =
  "min-h-11 rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800 disabled:bg-cream-200 disabled:text-ink-600";

/**
 * Mobile number or email → code from email. A mobile number gets the same
 * reply whether or not it is registered, so a new number signs up from the
 * code step by giving an email. Verification is a server action that opens
 * the session.
 */
export function OtpLoginForm({ verify }: { verify: VerifyLoginCode }) {
  const [step, setStep] = useState<Step>("identify");
  const [identifier, setIdentifier] = useState("");
  const [ownAgreed, setAgreed] = useState(false);
  // On the sign-in page one shared "I agree" covers every method.
  const shared = useSharedConsent();
  const agreed = shared ? shared.agreed : ownAgreed;
  const [mobile, setMobile] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  /** Where the code went: the email given, masked, or null for "the account's email, if registered". */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);

  // Tick once a second while a resend cooldown is running so the button re-enables itself.
  useEffect(() => {
    if (!resendAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [resendAt]);

  async function requestCode(next: { mobile: string | null; email: string | null }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/otp/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "Could not send a code. Please try again.");
        return;
      }
      setMobile(next.mobile);
      setEmail(next.email);
      setSentTo(body.status === "SENT" ? body.maskedEmail : null);
      setResendAt(Date.now() + (body.resendAfterSeconds ?? 60) * 1000);
      setNow(Date.now());
      setCode("");
      setStep("code");
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function submitIdentifier(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const value = identifier.trim();
    if (value.includes("@")) {
      if (!isValidEmail(value)) return setError(EMAIL_HINT);
      void requestCode({ mobile: null, email: value });
      return;
    }
    const parsed = parseIndianMobile(value);
    if (!parsed.ok) return setError(`${parsed.error} Or enter your email address.`);
    void requestCode({ mobile: parsed.national, email: null });
  }

  function submitEmail(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!isValidEmail(emailInput)) return setError(EMAIL_HINT);
    void requestCode({ mobile, email: emailInput.trim() });
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{4,8}$/.test(code.trim())) return setError("Enter the code we sent you.");
    setBusy(true);
    setError(null);
    const result = await verify({ mobile, email, code: code.trim() });
    // On success the server action redirects and never returns here.
    if (result?.error) setError(result.error);
    setBusy(false);
  }

  function startOver() {
    setStep("identify");
    setCode("");
    setEmailInput("");
    setMobile(null);
    setEmail(null);
    setError(null);
  }

  return (
    <div className="mt-6 border-t border-cream-200 pt-6" data-testid="otp-signin">
      <p className="mb-2 text-base font-semibold text-ink-900">Sign in with your mobile number or email</p>

      {step === "identify" ? (
        <form onSubmit={submitIdentifier}>
          <div className="flex gap-2">
            <input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              placeholder="10-digit mobile number or email"
              aria-label="Mobile number or email"
              className={`${inputClass} min-h-12 flex-1 text-base`}
              required
            />
            <button type="submit" disabled={busy || !agreed} className={buttonClass}>
              {busy ? "Sending…" : "Get code"}
            </button>
          </div>
          {shared && !agreed ? (
            <p className="mt-1">
              <ConsentHint />
            </p>
          ) : null}
          <label className={shared ? "hidden" : "mt-3 flex items-start gap-2 text-xs text-ink-600"}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
            <span>
              I agree to the{" "}
              <a href="/legal/terms" target="_blank" className="underline">
                Terms &amp; Conditions
              </a>{" "}
              and{" "}
              <a href="/legal/privacy-policy" target="_blank" className="underline">
                Privacy Policy
              </a>
              .
            </span>
          </label>
          <p className="mt-1 text-sm text-ink-600">The sign-in code is sent to your email (by SMS for shops registered with a mobile number only).</p>
        </form>
      ) : null}

      {step === "email" ? (
        <form onSubmit={submitEmail}>
          <p className="mb-2 text-sm text-ink-600">
            Enter your email address. We&apos;ll send the code there and link +91 {mobile} to your account.
          </p>
          <div className="flex gap-2">
            <input
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              aria-label="Email address"
              className={`${inputClass} flex-1`}
              required
            />
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </div>
          <button type="button" className="mt-2 text-xs underline" onClick={startOver}>
            Change number
          </button>
        </form>
      ) : null}

      {step === "code" ? (
        <form onSubmit={submitCode}>
          <p className="mb-2 text-sm text-ink-600" data-testid="otp-sent-to">
            {sentTo ? (
              <>
                We sent a code to <strong>{sentTo}</strong>.
              </>
            ) : (
              <>
                If +91 {mobile} is registered, we&apos;ve sent a code to the email address on that account — or by SMS, for a shop registered with its mobile number only.
              </>
            )}
          </p>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Enter code"
              aria-label="One-time code"
              maxLength={8}
              className={`${inputClass} flex-1 tracking-widest`}
              required
            />
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? "Checking…" : "Sign in"}
            </button>
          </div>
          <div className="mt-2 flex gap-3 text-xs">
            <button
              type="button"
              className="underline disabled:no-underline disabled:opacity-50"
              disabled={busy || now < resendAt}
              onClick={() => requestCode({ mobile, email })}
            >
              {now < resendAt ? `Resend code in ${Math.ceil((resendAt - now) / 1000)}s` : "Resend code"}
            </button>
            <button type="button" className="underline" onClick={startOver}>
              Use a different number or email
            </button>
          </div>
          {sentTo === null ? (
            <p className="mt-3 text-xs text-ink-600">
              New to GoKesari, or no email after a minute?{" "}
              <button
                type="button"
                className="font-medium text-kesari-700 underline"
                onClick={() => {
                  setError(null);
                  setStep("email");
                }}
              >
                Sign up with your email
              </button>
            </p>
          ) : null}
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
