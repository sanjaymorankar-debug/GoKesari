"use client";

import { useEffect, useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";
import { parseIndianMobile } from "@/lib/contact";

/** What POST /api/checkout answers (403 details) when the order needs a fresh SMS code. */
export interface CheckoutStepUpDetails {
  stepUp: "CHECKOUT_OTP";
  needsPhone: boolean;
  maskedPhone: string | null;
  mode: "every_checkout" | "once_per_hours";
}

export function isCheckoutStepUp(details: unknown): details is CheckoutStepUpDetails {
  return Boolean(details && typeof details === "object" && (details as { stepUp?: unknown }).stepUp === "CHECKOUT_OTP");
}

/**
 * docs/sms-2fa-2026-11 (rule checkoutOtp): confirm the order with a code sent
 * by SMS to the verified mobile (or to a number given here, saved as verified
 * once the code is right). `onVerified` places the order again.
 */
export function CheckoutOtpStep({ details, onVerified, onCancel }: { details: CheckoutStepUpDetails; onVerified: () => void; onCancel: () => void }) {
  const [needsNumber, setNeedsNumber] = useState(details.needsPhone);
  const [mobileInput, setMobileInput] = useState("");
  const [mobile, setMobile] = useState<string | null>(null);
  const [maskedPhone, setMaskedPhone] = useState(details.maskedPhone);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!resendAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [resendAt]);

  async function send(number: string | null) {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/checkout/otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(number ? { mobile: number } : {}),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setError(payload?.error?.message ?? "Could not send the SMS. Please try again.");
      if (payload?.error?.details?.needsPhone) setNeedsNumber(true);
      return;
    }
    setMobile(number);
    setMaskedPhone(payload.maskedPhone);
    setSent(true);
    setNeedsNumber(false);
    setResendAt(Date.now() + (payload.resendAfterSeconds ?? 60) * 1000);
    setNow(Date.now());
    setCode("");
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{4,8}$/.test(code.trim())) return setError("Enter the code we sent you by SMS.");
    setBusy(true);
    setError(null);
    const response = await fetch("/api/checkout/otp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim(), ...(mobile ? { mobile } : {}) }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setError(payload?.error?.message ?? "That code did not work. Please try again.");
      return;
    }
    onVerified();
  }

  return (
    <div className="space-y-2 rounded-lg border border-kesari-200 bg-kesari-50 p-3" data-testid="checkout-otp-step">
      <p className="text-sm font-semibold text-ink-900">Confirm your order with an SMS code</p>
      {needsNumber ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = parseIndianMobile(mobileInput);
            if (!parsed.ok) return setError(parsed.error);
            void send(parsed.national);
          }}
        >
          <p className="text-sm text-ink-700">Add your mobile number: we send a code there and save it as your verified number.</p>
          <input
            value={mobileInput}
            onChange={(e) => setMobileInput(e.target.value)}
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="10-digit mobile number"
            aria-label="Mobile number for the checkout code"
            className={inputClass}
            required
          />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Sending…" : "Send SMS code"}
          </Button>
        </form>
      ) : !sent ? (
        <div className="space-y-2">
          <p className="text-sm text-ink-700">
            We send a one-time code by SMS to <strong>{maskedPhone}</strong>
            {details.mode === "once_per_hours" ? "; it covers your orders for a while." : " for this order."}
          </p>
          <Button type="button" disabled={busy} className="w-full" onClick={() => send(null)}>
            {busy ? "Sending…" : "Send SMS code"}
          </Button>
        </div>
      ) : (
        <form className="space-y-2" onSubmit={verify}>
          <p className="text-sm text-ink-700" data-testid="checkout-otp-sent-to">
            Code sent by SMS to <strong>{maskedPhone}</strong>.
          </p>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="SMS code"
            aria-label="Checkout SMS code"
            maxLength={8}
            className={`${inputClass} tracking-widest`}
            required
          />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Checking…" : "Verify and place order"}
          </Button>
          <button
            type="button"
            className="text-xs underline disabled:no-underline disabled:opacity-50"
            disabled={busy || now < resendAt}
            onClick={() => send(mobile)}
          >
            {now < resendAt ? `Resend SMS in ${Math.ceil((resendAt - now) / 1000)}s` : "Resend SMS"}
          </button>
        </form>
      )}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <button type="button" className="text-xs underline" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
