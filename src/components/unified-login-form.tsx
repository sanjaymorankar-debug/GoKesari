"use client";

import { useEffect, useState } from "react";
import { COUNTRY_CODES } from "@/lib/phone";

type Step = "identifier" | "code" | "mobile-if-email";
type LoginMethod = "mobile" | "email";
type Verify = (input: {
  countryCode?: string;
  mobile?: string;
  email?: string;
  code: string;
}) => Promise<{ error?: string; requiresMobile?: boolean } | void>;

const inputClass =
  "min-w-0 rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none";
const buttonClass =
  "rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-700 disabled:opacity-50";

export function UnifiedLoginForm({
  verify,
  emailAvailable,
}: {
  verify: Verify;
  emailAvailable: boolean;
}) {
  const [step, setStep] = useState<Step>("identifier");
  const [loginMethod, setLoginMethod] = useState<LoginMethod>("mobile");
  const [countryCode, setCountryCode] = useState("+91");
  const [mobile, setMobile] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  const [maskedEmail, setMaskedEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!resendAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [resendAt]);

  async function sendCode() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const payload = loginMethod === "mobile"
        ? { countryCode, mobile }
        : { email };

      const res = await fetch("/api/otp/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, channel: "EMAIL" }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error?.message ?? "Could not send a code. Please try again.");
        return;
      }
      setMessage(body.message);
      setResendAt(Date.now() + (body.resendAfterSeconds ?? 60) * 1000);
      if (body.maskedEmail) {
        setMaskedEmail(body.maskedEmail);
      }
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
    try {
      const payload = loginMethod === "mobile"
        ? { countryCode, mobile, code }
        : { email, code };

      const result = await verify(payload);
      // On success the server action redirects and never returns here.
      if (result?.error) {
        setError(result.error);
      }
      if (result?.requiresMobile) {
        setStep("mobile-if-email");
      }
    } finally {
      setBusy(false);
    }
  }

  const resendDisabled = Date.now() < resendAt;
  const resendSeconds = Math.ceil((resendAt - now) / 1000);

  return (
    <div className="mt-6 border-t border-cream-200 pt-6">
      <p className="mb-4 text-sm font-medium text-ink-700">Sign in with mobile or email</p>

      {step === "identifier" && (
        <div className="space-y-4">
          {/* Method selector */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setLoginMethod("mobile")}
              className={`flex-1 rounded-lg border-2 px-4 py-2 text-sm font-medium transition-colors ${
                loginMethod === "mobile"
                  ? "border-kesari-500 bg-kesari-50 text-kesari-700"
                  : "border-cream-200 text-ink-700 hover:border-cream-300"
              }`}
            >
              Mobile Number
            </button>
            {emailAvailable && (
              <button
                type="button"
                onClick={() => setLoginMethod("email")}
                className={`flex-1 rounded-lg border-2 px-4 py-2 text-sm font-medium transition-colors ${
                  loginMethod === "email"
                    ? "border-kesari-500 bg-kesari-50 text-kesari-700"
                    : "border-cream-200 text-ink-700 hover:border-cream-300"
                }`}
              >
                Email
              </button>
            )}
          </div>

          {/* Mobile input */}
          {loginMethod === "mobile" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                if (!/^[\d\s-]{6,15}$/.test(mobile)) {
                  setError("Enter a valid mobile number.");
                  return;
                }
                sendCode();
              }}
              className="flex gap-2"
            >
              <select
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                className={inputClass}
              >
                {COUNTRY_CODES.map((cc) => (
                  <option key={cc} value={cc}>
                    {cc}
                  </option>
                ))}
              </select>
              <input
                type="tel"
                placeholder="Mobile number"
                value={mobile}
                onChange={(e) => setMobile(e.target.value.replace(/\D/g, ""))}
                className={`flex-1 ${inputClass}`}
                autoFocus
              />
              <button type="submit" disabled={busy} className={buttonClass}>
                {busy ? "..." : "Send"}
              </button>
            </form>
          )}

          {/* Email input */}
          {loginMethod === "email" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                  setError("Enter a valid email address.");
                  return;
                }
                sendCode();
              }}
              className="flex gap-2"
            >
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value.toLowerCase())}
                className={`flex-1 ${inputClass}`}
                autoFocus
              />
              <button type="submit" disabled={busy} className={buttonClass}>
                {busy ? "..." : "Send"}
              </button>
            </form>
          )}

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}
        </div>
      )}

      {step === "code" && (
        <form onSubmit={submitCode} className="space-y-4">
          {message && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm text-amber-900">{message}</p>
              {maskedEmail && (
                <p className="mt-1 text-xs text-amber-800">
                  Code sent to {maskedEmail}
                </p>
              )}
            </div>
          )}

          <input
            type="text"
            placeholder="Enter 6-8 digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className={`w-full ${inputClass}`}
            maxLength={8}
            autoFocus
          />

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep("identifier")}
              className="flex-1 rounded-lg border border-cream-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={busy || code.length < 4}
              className={`flex-1 ${buttonClass}`}
            >
              {busy ? "..." : "Verify"}
            </button>
          </div>

          <button
            type="button"
            onClick={sendCode}
            disabled={resendDisabled || busy}
            className="w-full text-sm text-kesari-600 hover:underline disabled:text-ink-400"
          >
            {resendDisabled
              ? `Resend in ${resendSeconds}s`
              : "Resend code"}
          </button>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}
        </form>
      )}

      {step === "mobile-if-email" && (
        <div className="space-y-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            Add your mobile number for faster login next time.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              // TODO: call addMobileNumber API
            }}
            className="flex gap-2"
          >
            <input
              type="tel"
              placeholder="Mobile number"
              pattern="[0-9\s-]{6,15}"
              className={`flex-1 ${inputClass}`}
            />
            <button type="submit" className={buttonClass}>
              Add
            </button>
          </form>
          <button
            type="button"
            onClick={() => {
              // Redirect to dashboard
              window.location.href = "/";
            }}
            className="w-full text-sm text-kesari-600 hover:underline"
          >
            Continue without adding →
          </button>
        </div>
      )}
    </div>
  );
}
