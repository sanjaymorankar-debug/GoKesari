"use client";

import { createContext, useContext, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * One "I agree to the Terms & Conditions and Privacy Policy" box for the whole
 * sign-in page: ticking it once unlocks every sign-in method (Google, code,
 * emailed link) instead of asking the same question under each of them.
 */
const ConsentContext = createContext<boolean>(false);
const SetConsentContext = createContext<(agreed: boolean) => void>(() => {});

export function SignInConsentProvider({ children }: { children: ReactNode }) {
  const [agreed, setAgreed] = useState(false);
  return (
    <SetConsentContext.Provider value={setAgreed}>
      <ConsentContext.Provider value={agreed}>{children}</ConsentContext.Provider>
    </SetConsentContext.Provider>
  );
}

export function useSignInConsent(): boolean {
  return useContext(ConsentContext);
}

export function SignInConsentCheckbox({ className = "" }: { className?: string }) {
  const agreed = useContext(ConsentContext);
  const setAgreed = useContext(SetConsentContext);
  return (
    <label className={`flex min-h-11 cursor-pointer items-start gap-2.5 text-sm text-ink-700 ${className}`} data-testid="signin-consent">
      <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 shrink-0" />
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
  );
}

/** A submit button that stays disabled until the consent box is ticked. */
export function ConsentSubmitButton({ disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const agreed = useContext(ConsentContext);
  return <button type="submit" {...props} disabled={disabled || !agreed} />;
}
