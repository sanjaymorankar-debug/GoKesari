"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import clsx from "clsx";

/**
 * One "I agree" for every sign-in method (it used to be asked three times,
 * once per method). The tick is still the affirmative action DPDPA §6 asks
 * for: no method can start until it is ticked, and each says why while it
 * waits.
 */
const ConsentContext = createContext<{ agreed: boolean; setAgreed: (v: boolean) => void } | null>(null);

export function ConsentProvider({ children }: { children: ReactNode }) {
  const [agreed, setAgreed] = useState(false);
  return <ConsentContext.Provider value={{ agreed, setAgreed }}>{children}</ConsentContext.Provider>;
}

/** The shared consent, when the page has one (the sign-in page); null elsewhere. */
export function useSharedConsent() {
  return useContext(ConsentContext);
}

export function ConsentCheckbox() {
  const ctx = useContext(ConsentContext);
  if (!ctx) return null;
  return (
    <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-[var(--gk-line)] bg-[var(--gk-chip)] p-3 text-sm text-ink-900" data-testid="signin-consent">
      <input
        type="checkbox"
        checked={ctx.agreed}
        onChange={(e) => ctx.setAgreed(e.target.checked)}
        className="mt-0.5 h-5 w-5 shrink-0 accent-kesari-700"
      />
      <span>
        I agree to the{" "}
        <a href="/legal/terms" target="_blank" className="font-semibold underline">
          Terms &amp; Conditions
        </a>{" "}
        and{" "}
        <a href="/legal/privacy-policy" target="_blank" className="font-semibold underline">
          Privacy Policy
        </a>
        .
      </span>
    </label>
  );
}

/** A sign-in method's submit button: usable once the shared consent is ticked, with the reason shown until then. */
export function ConsentSubmit({ children, className }: { children: ReactNode; className?: string }) {
  const ctx = useContext(ConsentContext);
  const agreed = ctx?.agreed ?? true;
  return (
    <span className="flex flex-col gap-1">
      <button
        type="submit"
        disabled={!agreed}
        className={clsx(
          "flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold disabled:cursor-not-allowed disabled:bg-cream-200 disabled:text-ink-600",
          className,
        )}
      >
        {children}
      </button>
      {!agreed ? <ConsentHint /> : null}
    </span>
  );
}

export function ConsentHint() {
  return <span className="text-sm text-ink-700">Tick “I agree” above to continue.</span>;
}
