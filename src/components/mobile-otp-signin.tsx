"use client";

import { useEffect, useState } from "react";

import { COUNTRY_CODES } from "@/lib/phone";

type Step = "mobile" | "channel" | "code";
type Verify = (input: {
  countryCode: string;
  mobile: string;
  code: string;
}) => Promise<{ error?: string } | void>;

const inputClass =
  "min-w-0 rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none";
const buttonClass =
  "rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-700 disabled:opacity-50";

/** Mobile number → choose email/SMS → enter code. Verification is a server action that calls Auth.js. */
export function MobileOtpSignIn({
  verify,
  smsAvailable,
  emailAvailable,
}: {
  verify: Verify;
  smsAvailable: boolean;
  emailAvailable: boolean;
}) {
  const [step, setStep] = useState<Step>("mobile");
  const [countryCode, setCountryCode] = useState("+91");
  const [mobile, setMobile] = useState("");
  const [channel, setChannel] = useState<"EMAIL" | "SMS">(emailAvailable ? "EMAIL" : "SMS");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
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

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/otp/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ countryCode, mobile, channel }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error?.message ?? "Could not send a code. Please try again.");
        return;
      }
      setMessage(body.message);
      setResendAt(Date.now() + (body.resendAfterSeconds ?? 60) * 1000);
      setStep("code");
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await verify({ countryCode, mobile, code });
    // On success the server action redirects and never returns here.
    if (result?.error) setError(result.error);
    setBusy(false);
  }

  return (
    <div className="mt-6 border-t border-cream-200 pt-6" data-testid="mobile-signin">
      <p className="mb-2 text-sm font-medium text-ink-700">Login with mobile number</p>

      {step === "mobile" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (!/^[\d\s-]{6,15}$/.test(mobile)) {
              setError("Enter a valid mobile number.");
              return;
            }
            setStep("channel");
          }}
          className="flex gap-2"
        >
          <select
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className={inputClass}
            aria-label="Country code"
          >
            {COUNTRY_CODES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            inputMode="numeric"
            autoComplete="tel-national"
            placeholder="Mobile number"
            aria-label="Mobile number"
            className={`${inputClass} flex-1`}
            required
          />
          <button type="submit" className={buttonClass}>
            Next
          </button>
        </form>
      ) : null}

      {step === "channel" ? (
        <div>
          <p className="text-sm text-ink-700">Where would you like to receive your OTP?</p>
          <div className="mt-2 space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={channel === "EMAIL"}
                onChange={() => setChannel("EMAIL")}
                disabled={!emailAvailable}
              />
              Email (to the address on your account)
            </label>
            <label className={`flex items-center gap-2 ${smsAvailable ? "" : "text-ink-400"}`}>
              <input
                type="radio"
                checked={channel === "SMS"}
                onChange={() => setChannel("SMS")}
                disabled={!smsAvailable}
              />
              SMS {smsAvailable ? "" : "(coming soon)"}
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setStep("mobile")}
              className="rounded-lg border border-cream-200 px-4 py-2 text-sm"
            >
              Back
            </button>
            <button
              type="button"
              onClick={sendCode}
              disabled={busy || (!emailAvailable && !smsAvailable)}
              className={buttonClass}
            >
              {busy ? "Sending…" : "Send OTP"}
            </button>
          </div>
          {!emailAvailable && !smsAvailable ? (
            <p className="mt-2 text-xs text-amber-800">
              Code delivery is not configured on this server yet.
            </p>
          ) : null}
        </div>
      ) : null}

      {step === "code" ? (
        <form onSubmit={submitCode}>
          {message ? <p className="mb-2 text-sm text-ink-600">{message}</p> : null}
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
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
              onClick={sendCode}
            >
              Resend code
            </button>
            <button
              type="button"
              className="underline"
              onClick={() => {
                setStep("mobile");
                setCode("");
              }}
            >
              Change number
            </button>
          </div>
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
