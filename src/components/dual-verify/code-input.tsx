"use client";

import { useEffect, useRef } from "react";

/**
 * docs/dual-auth-2026-11: one 6-digit code box for every DualVerify step.
 *   - iOS / Safari and the iOS app (WKWebView): autocomplete="one-time-code" offers the code from the SMS / Mail.
 *   - Android (Chrome, Gboard, the Android app's WebView): the same hint lets the keyboard offer the SMS code;
 *     in Chrome the WebOTP API also reads it automatically when the SMS ends with "@<host> #<code>".
 *     // DEFAULT – confirm with Sanjay: the native SMS Retriever API needs an app hash inside the DLT SMS template
 *     and a new store build; the keyboard / WebOTP autofill works today in the apps, which are WebView shells.
 */
export function CodeInput({
  value,
  onChange,
  label,
  sms = false,
  autoFocus = false,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** The code comes by SMS: also listen with WebOTP where the browser has it. */
  sms?: boolean;
  autoFocus?: boolean;
  testId?: string;
}) {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!sms || typeof window === "undefined" || !("OTPCredential" in window)) return;
    const abort = new AbortController();
    const credentials = navigator.credentials as unknown as { get: (o: unknown) => Promise<{ code?: string } | null> };
    credentials
      .get({ otp: { transport: ["sms"] }, signal: abort.signal })
      .then((otp) => {
        if (otp?.code) latest.current(otp.code.replace(/\D/g, "").slice(0, 8));
      })
      .catch(() => {});
    return () => abort.abort();
  }, [sms]);

  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 8))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={8}
      placeholder="6-digit code"
      aria-label={label}
      autoFocus={autoFocus}
      data-testid={testId}
      className="min-h-11 min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-base tracking-widest focus:border-kesari-500 focus:outline-none"
    />
  );
}
