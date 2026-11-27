"use client";

import { useEffect, useState } from "react";

import { parseIndianMobile } from "@/lib/contact";
import { postJson } from "./api";
import { CodeInput } from "./code-input";

export interface DualVerifyState {
  mobileVerified: boolean;
  emailVerified: boolean;
  placeholderEmail: boolean;
  missing: ("MOBILE" | "EMAIL")[];
  maskedPhone: string | null;
  maskedEmail: string | null;
  inForce: boolean;
  canVerify?: boolean;
}

const inputClass = "min-h-11 min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-base focus:border-kesari-500 focus:outline-none";
const buttonClass =
  "min-h-11 rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800 disabled:bg-cream-200 disabled:text-ink-600";

function useCountdown(at: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [at]);
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** Step: the mobile number by an SMS code. */
function MobileStep({ onVerified, knownMasked }: { onVerified: (s: DualVerifyState) => void; knownMasked: string | null }) {
  const [mobile, setMobile] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const wait = useCountdown(resendAt);

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const parsed = parseIndianMobile(mobile);
    if (!parsed.ok) return setError(parsed.error);
    setBusy(true);
    setError(null);
    const res = await postJson<{ sent: { sentTo: string; resendAfterSeconds: number } }>("/api/dual-auth/verify", { action: "mobile-code", mobile: parsed.national });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setSentTo(res.data.sent.sentTo);
    setResendAt(Date.now() + res.data.sent.resendAfterSeconds * 1000);
    setCode("");
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (code.length < 4) return setError("Enter the code we sent you by SMS.");
    setBusy(true);
    setError(null);
    const res = await postJson<{ status: DualVerifyState }>("/api/dual-auth/verify", { action: "mobile-verify", mobile: parseIndianMobile(mobile).ok ? mobile : undefined, code });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    onVerified(res.data.status);
  }

  return (
    <section className="rounded-xl border border-cream-200 p-4" data-testid="dual-verify-mobile">
      <h2 className="font-medium text-ink-900">Mobile number</h2>
      <p className="mt-1 text-sm text-ink-600">
        {knownMasked ? <>Confirm your mobile ({knownMasked}) or enter the number to use. </> : null}
        We send a 6-digit code by SMS. It works for 5 minutes.
      </p>
      {!sentTo ? (
        <form onSubmit={send} className="mt-3 flex gap-2">
          <span className="self-center text-sm text-ink-600">+91</span>
          <input
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="10-digit mobile number"
            aria-label="Mobile number"
            className={inputClass}
            data-testid="dual-verify-mobile-input"
            required
          />
          <button type="submit" className={buttonClass} disabled={busy} data-testid="dual-verify-mobile-send">
            {busy ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="mt-3 space-y-2">
          <p className="text-sm text-ink-700" data-testid="dual-verify-mobile-sent">
            Code sent by SMS to <strong>{sentTo}</strong>.
          </p>
          <div className="flex gap-2">
            <CodeInput value={code} onChange={setCode} label="SMS code" sms autoFocus testId="dual-verify-mobile-code" />
            <button type="submit" className={buttonClass} disabled={busy} data-testid="dual-verify-mobile-verify">
              {busy ? "Checking…" : "Verify"}
            </button>
          </div>
          <div className="flex gap-3 text-xs">
            <button type="button" className="underline disabled:no-underline disabled:opacity-50" disabled={busy || wait > 0} onClick={() => send()}>
              {wait > 0 ? `Resend in ${wait}s` : "Resend code"}
            </button>
            <button type="button" className="underline" onClick={() => setSentTo(null)}>
              Change number
            </button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** Step: the e-mail by a code (the account's address, or the one a mobile-only account adds). */
type LinkAction = (email?: string | null) => Promise<{ error?: string; sent?: boolean; sentTo?: string }>;

function EmailStep({ state, onVerified, linkAction }: { state: DualVerifyState; onVerified: (s: DualVerifyState) => void; linkAction?: LinkAction }) {
  const needsAddress = state.placeholderEmail;
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const wait = useCountdown(resendAt);

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    const res = await postJson<{ sent: { sentTo: string; resendAfterSeconds: number } }>("/api/dual-auth/verify", { action: "email-code", ...(needsAddress ? { email } : {}) });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setSentTo(res.data.sent.sentTo);
    setResendAt(Date.now() + res.data.sent.resendAfterSeconds * 1000);
    setCode("");
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (code.length < 4) return setError("Enter the code we e-mailed you.");
    setBusy(true);
    setError(null);
    const res = await postJson<{ status: DualVerifyState }>("/api/dual-auth/verify", { action: "email-verify", ...(needsAddress ? { email } : {}), code });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    onVerified(res.data.status);
  }

  async function sendLink() {
    if (!linkAction) return;
    if (needsAddress && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("Enter a valid email address, e.g. name@example.com.");
    setBusy(true);
    setError(null);
    const res = await linkAction(needsAddress ? email.trim() : null);
    setBusy(false);
    if (res.error) setError(res.error);
    else if (needsAddress) setInfo(`We e-mailed a link to ${res.sentTo ?? email.trim()}. Open it within 15 minutes and press Confirm (it works once). Then come back here.`);
    else setInfo(`We e-mailed a sign-in link to ${state.maskedEmail}. Open it on this device within 15 minutes (it works once).`);
  }

  return (
    <section className="rounded-xl border border-cream-200 p-4" data-testid="dual-verify-email">
      <h2 className="font-medium text-ink-900">E-mail</h2>
      <p className="mt-1 text-sm text-ink-600">
        {needsAddress ? "Add your e-mail address. " : <>We verify {state.maskedEmail}. </>}
        We send a 6-digit code. It works for 10 minutes.
      </p>
      {!sentTo ? (
        <form onSubmit={send} className="mt-3 flex flex-wrap gap-2">
          {needsAddress ? (
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="name@example.com"
              aria-label="E-mail address"
              className={inputClass}
              data-testid="dual-verify-email-input"
              required
            />
          ) : null}
          <button type="submit" className={buttonClass} disabled={busy} data-testid="dual-verify-email-send">
            {busy ? "Sending…" : "E-mail me a code"}
          </button>
          {linkAction ? (
            <button type="button" className="min-h-11 rounded-lg border border-cream-200 px-4 py-2 text-sm" disabled={busy} onClick={sendLink} data-testid="dual-verify-email-link">
              E-mail me a link instead
            </button>
          ) : null}
        </form>
      ) : (
        <form onSubmit={verify} className="mt-3 space-y-2">
          <p className="text-sm text-ink-700" data-testid="dual-verify-email-sent">
            Code sent to <strong>{sentTo}</strong>.
          </p>
          <div className="flex gap-2">
            <CodeInput value={code} onChange={setCode} label="E-mail code" autoFocus testId="dual-verify-email-code" />
            <button type="submit" className={buttonClass} disabled={busy} data-testid="dual-verify-email-verify">
              {busy ? "Checking…" : "Verify"}
            </button>
          </div>
          <button type="button" className="text-xs underline disabled:no-underline disabled:opacity-50" disabled={busy || wait > 0} onClick={() => send()}>
            {wait > 0 ? `Resend in ${wait}s` : "Resend code"}
          </button>
        </form>
      )}
      {info ? <p className="mt-2 text-sm text-emerald-800">{info}</p> : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * docs/dual-auth-2026-11 — DualVerify: the missing factor(s) of a signed-in account, then back to `returnTo`.
 * The same component on web and in the Android / iOS apps (WebView).
 */
export function DualVerifyPanel({ initial, returnTo, linkAction }: { initial: DualVerifyState; returnTo: string; linkAction?: LinkAction }) {
  const [state, setState] = useState(initial);
  const done = state.missing.length === 0;

  useEffect(() => {
    if (done) {
      const t = setTimeout(() => window.location.assign(returnTo), 1200);
      return () => clearTimeout(t);
    }
  }, [done, returnTo]);

  if (done) {
    return (
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="dual-verify-done">
        Your mobile and e-mail are both verified. Taking you back…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <ol className="flex gap-2 text-xs text-ink-600" aria-label="Progress">
        <li className={state.mobileVerified ? "text-emerald-700" : "font-medium text-ink-900"}>{state.mobileVerified ? "✓ " : "1. "}Mobile</li>
        <li aria-hidden>·</li>
        <li className={state.emailVerified ? "text-emerald-700" : "font-medium text-ink-900"}>{state.emailVerified ? "✓ " : "2. "}E-mail</li>
      </ol>
      {!state.mobileVerified ? <MobileStep onVerified={setState} knownMasked={state.maskedPhone} /> : null}
      {state.mobileVerified && !state.emailVerified ? <EmailStep state={state} onVerified={setState} linkAction={linkAction} /> : null}
    </div>
  );
}
