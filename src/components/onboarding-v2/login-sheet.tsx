"use client";

/**
 * docs/onboarding-v2-2026-11, Flow 1: the login sheet (bottom sheet on phones, dialog on wider screens). Opened by
 * "Place order" and by account-only actions while the flag onboarding_v2 is on. The cart is never touched: a
 * guest's cart stays in the browser and GuestCartMerge moves it into the account once signed in.
 *
 *   1  Terms & Privacy tick (mandatory) — version and time (IST) stored.
 *   2  E-mail verified — Continue with Google, or the e-mailed sign-in link (app / no link sender: e-mailed code).
 *      Comes back to the same page with ?sheet=resume and the sheet continues by itself.
 *   3  Mobile code by SMS (or saved unverified where no SMS can be sent, rule mobileOtpFallbackWhenNoSms).
 *   4  Done: back to checkout. Returning customers with everything done never see the sheet.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useState, useTransition, type ReactNode } from "react";

import { Alert, Button, inputClass } from "@/components/ui";
import { parseIndianMobile } from "@/lib/contact";
import {
  sheetGoogleSignIn,
  sheetRequestEmailCode,
  sheetSendMagicLink,
  sheetVerifyEmailCode,
} from "@/server/onboarding-v2/sheet-actions";
import type { CustomerLoginStatus, CustomerSheetStep } from "@/server/onboarding-v2/customer";

export interface LoginSheetOptions {
  /** The page to come back to after the e-mail step (default: this page). */
  returnTo?: string;
  /** Called once the sheet is finished (signed in, mobile done). */
  onDone?: () => void;
}

const OPEN_EVENT = "gk:open-login-sheet";
const LoginSheetContext = createContext<((options?: LoginSheetOptions) => void) | null>(null);

/** The opener while onboarding_v2 is on; null when it is off (callers keep their old behaviour). */
export function useLoginSheet(): ((options?: LoginSheetOptions) => void) | null {
  return useContext(LoginSheetContext);
}

/** For code outside React: opens the sheet if the provider is mounted (no-op otherwise). */
export function openLoginSheet(returnTo?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { returnTo } }));
}

export interface LoginSheetConfig {
  signedIn: boolean;
  googleEnabled: boolean;
  /** The e-mailed sign-in link is offered (a link sender exists, and not inside the app). */
  magicLinkEnabled: boolean;
}

export function LoginSheetProvider({ enabled, config, children }: { enabled: boolean; config: LoginSheetConfig; children: ReactNode }) {
  const [open, setOpen] = useState<LoginSheetOptions | null>(null);
  const openSheet = useCallback((options: LoginSheetOptions = {}) => setOpen(options), []);
  const openResume = useCallback(() => setOpen({}), []);

  useEffect(() => {
    if (!enabled) return;
    const onOpen = (event: Event) => setOpen({ returnTo: (event as CustomEvent<{ returnTo?: string }>).detail?.returnTo });
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [enabled]);

  if (!enabled) return <>{children}</>;
  return (
    <LoginSheetContext.Provider value={openSheet}>
      {children}
      {/* useSearchParams needs a boundary. */}
      <Suspense fallback={null}>
        <ResumeWatcher signedIn={config.signedIn} onResume={openResume} />
        {open ? <LoginSheet config={config} options={open} onClose={() => setOpen(null)} /> : null}
      </Suspense>
    </LoginSheetContext.Provider>
  );
}

/** ?sheet=resume after Google / the link / the code: reopen the sheet for the remaining steps. */
function ResumeWatcher({ signedIn, onResume }: { signedIn: boolean; onResume: () => void }) {
  const params = useSearchParams();
  const resume = signedIn && params.get("sheet") === "resume";
  useEffect(() => {
    if (resume) onResume();
  }, [resume, onResume]);
  return null;
}

async function fetchStatus(): Promise<{ ok: true; status: CustomerLoginStatus } | { ok: false; message: string }> {
  const response = await fetch("/api/onboarding-v2/customer/status", { method: "POST" }).catch(() => null);
  const payload = await response?.json().catch(() => null);
  if (!response?.ok) return { ok: false, message: payload?.error?.message ?? "Could not check your account. Please try again." };
  return { ok: true, status: payload as CustomerLoginStatus };
}

const STEP_NUMBER: Record<CustomerSheetStep, number> = { CONSENT: 1, EMAIL: 2, MOBILE: 3, DONE: 4 };
const STEP_TITLE: Record<CustomerSheetStep, string> = {
  CONSENT: "Before you place your order",
  EMAIL: "Verify your email",
  MOBILE: "Verify your mobile number",
  DONE: "All set",
};

function LoginSheet({ config, options, onClose }: { config: LoginSheetConfig; options: LoginSheetOptions; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const returnTo = options.returnTo ?? pathname;
  const [step, setStep] = useState<CustomerSheetStep | null>(config.signedIn ? null : "CONSENT");
  const [status, setStatus] = useState<CustomerLoginStatus | null>(null);
  const [acceptedAtIst, setAcceptedAtIst] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finish = useCallback(() => {
    onClose();
    if (params.get("sheet") === "resume") {
      const next = new URLSearchParams(params.toString());
      next.delete("sheet");
      router.replace(next.size > 0 ? `${pathname}?${next}` : pathname);
    }
    router.refresh();
    options.onDone?.();
  }, [onClose, options, params, pathname, router]);

  const applyStatus = useCallback(
    (result: { ok: true; status: CustomerLoginStatus } | { ok: false; message: string }) => {
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError(null);
      setStatus(result.status);
      if (result.status.step === "DONE") finish();
      else setStep(result.status.step);
    },
    [finish],
  );
  const loadStatus = useCallback(async () => applyStatus(await fetchStatus()), [applyStatus]);

  useEffect(() => {
    // Signed in: ask where this account stands (also writes a tick given before signing in).
    if (!config.signedIn) return;
    let cancelled = false;
    void (async () => {
      const result = await fetchStatus();
      if (!cancelled) applyStatus(result);
    })();
    return () => {
      cancelled = true;
    };
    // Once per opening of the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-[75] flex items-end justify-center bg-ink-900/50 p-0 sm:items-center sm:p-4" data-testid="login-sheet">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-sheet-title"
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            {step && step !== "DONE" ? <p className="text-xs font-semibold uppercase tracking-wide text-kesari-700">Step {STEP_NUMBER[step]} of 3</p> : null}
            <h2 id="login-sheet-title" className="text-lg font-bold text-ink-900">
              {step ? STEP_TITLE[step] : "One moment…"}
            </h2>
          </div>
          <button type="button" onClick={onClose} className="tap-target rounded-lg px-2 text-2xl leading-none text-ink-600 hover:bg-cream-100" aria-label="Close">
            ×
          </button>
        </div>
        <p className="mt-1 text-sm text-ink-600">Your cart is kept. Nothing is charged until you pay.</p>

        <div className="mt-4 space-y-3">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {step === "CONSENT" ? (
            <ConsentStep
              onAccepted={(ist, recorded) => {
                setAcceptedAtIst(ist);
                if (recorded) void loadStatus();
                else setStep("EMAIL");
              }}
            />
          ) : null}
          {step === "EMAIL" ? (
            config.signedIn ? (
              <Alert tone="warning" title="Your email is not verified yet">
                Add and confirm your email in{" "}
                <a href="/profile" className="font-medium underline">
                  My profile
                </a>
                , then come back to the cart.
              </Alert>
            ) : (
              <EmailStep config={config} returnTo={returnTo} acceptedAtIst={acceptedAtIst} />
            )
          ) : null}
          {step === "MOBILE" ? <MobileStep status={status} onVerified={loadStatus} /> : null}
        </div>
      </div>
    </div>
  );
}

function ConsentStep({ onAccepted }: { onAccepted: (acceptedAtIst: string, recorded: boolean) => void }) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function accept() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/onboarding-v2/customer/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted: true }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setError(payload?.error?.message ?? "Could not save your choice. Please try again.");
      return;
    }
    onAccepted(payload.acceptedAtIst, Boolean(payload.recorded));
  }
  return (
    <div className="space-y-3" data-testid="login-sheet-consent">
      <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-sm text-ink-700">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 shrink-0" data-testid="login-sheet-consent-box" />
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
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button size="lg" className="w-full font-bold" disabled={!agreed || busy} onClick={accept} data-testid="login-sheet-consent-continue">
        {busy ? "Saving…" : "Continue"}
      </Button>
    </div>
  );
}

function EmailStep({ config, returnTo, acceptedAtIst }: { config: LoginSheetConfig; returnTo: string; acceptedAtIst: string | null }) {
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState(false);
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const useCode = !config.magicLinkEnabled;

  return (
    <div className="space-y-3" data-testid="login-sheet-email">
      {acceptedAtIst ? <p className="text-xs text-ink-600">Terms accepted {acceptedAtIst}.</p> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {config.googleEnabled ? (
        <Button
          variant="secondary"
          size="lg"
          className="w-full"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await sheetGoogleSignIn(returnTo);
              if (result?.error) setError(result.error);
            })
          }
          data-testid="login-sheet-google"
        >
          Continue with Google
        </Button>
      ) : null}
      <div className="flex items-center gap-2 text-xs text-ink-500">
        <span className="h-px flex-1 bg-cream-200" />
        {config.googleEnabled ? "or with your email" : "with your email"}
        <span className="h-px flex-1 bg-cream-200" />
      </div>
      {linkSent ? (
        <Alert tone="success" title="Check your email">
          We sent a sign-in link to {email}. Open it on this phone or computer — you come back to your cart and continue
          here. It works once and expires in 15 minutes.
        </Alert>
      ) : codeSentTo ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              const result = await sheetVerifyEmailCode(email, code, returnTo);
              if (result?.error) setError(result.error);
              else if (result?.secondFactor) setError("Your account also needs an SMS code at sign-in: please sign in on the Sign in page, then come back to your cart.");
            });
          }}
        >
          <label className="block text-sm font-medium text-ink-700" htmlFor="sheet-email-code">
            Code sent to {codeSentTo}
          </label>
          <input id="sheet-email-code" className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} />
          <Button type="submit" size="lg" className="w-full font-bold" disabled={pending || code.length < 4} data-testid="login-sheet-email-verify">
            {pending ? "Checking…" : "Verify email"}
          </Button>
        </form>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              if (useCode) {
                const result = await sheetRequestEmailCode(email);
                if (result.error) setError(result.error);
                else setCodeSentTo(result.maskedEmail ?? email);
              } else {
                const result = await sheetSendMagicLink(email, returnTo);
                if (result.error) setError(result.error);
                else setLinkSent(true);
              }
            });
          }}
        >
          <label className="block text-sm font-medium text-ink-700" htmlFor="sheet-email">
            Email address
          </label>
          <input id="sheet-email" type="email" autoComplete="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          <Button type="submit" size="lg" className="w-full font-bold" disabled={pending || !email.includes("@")} data-testid="login-sheet-email-send">
            {pending ? "Sending…" : useCode ? "Email me a code" : "Email me a sign-in link"}
          </Button>
        </form>
      )}
    </div>
  );
}

function MobileStep({ status, onVerified }: { status: CustomerLoginStatus | null; onVerified: () => Promise<void> }) {
  const [mobile, setMobile] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseIndianMobile(mobile);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/onboarding-v2/customer/mobile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setError(payload?.error?.message ?? "Something went wrong. Please try again.");
      return null;
    }
    return payload;
  }

  if (status?.blockedReason) return <Alert tone="danger">{status.blockedReason}</Alert>;
  return (
    <div className="space-y-3" data-testid="login-sheet-mobile">
      <p className="text-sm text-ink-600">The delivery partner and the shop use it to reach you.</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {sentTo ? (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post({ action: "verify", mobile, code })) await onVerified();
          }}
        >
          <label className="block text-sm font-medium text-ink-700" htmlFor="sheet-mobile-code">
            Code sent by SMS to {sentTo}
          </label>
          <input id="sheet-mobile-code" className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} data-testid="login-sheet-mobile-code" />
          <Button type="submit" size="lg" className="w-full font-bold" disabled={busy || code.length < 4} data-testid="login-sheet-mobile-verify">
            {busy ? "Checking…" : "Verify mobile"}
          </Button>
          <button type="button" className="text-sm text-kesari-700 underline" onClick={() => setSentTo(null)}>
            Change number
          </button>
        </form>
      ) : (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await post({ action: "send", mobile });
            if (!result) return;
            if (result.status === "SAVED_UNVERIFIED") await onVerified();
            else setSentTo(result.maskedPhone);
          }}
        >
          <label className="block text-sm font-medium text-ink-700" htmlFor="sheet-mobile">
            Mobile number
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-600">+91</span>
            <input id="sheet-mobile" className={inputClass} inputMode="tel" autoComplete="tel-national" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="98765 43210" data-testid="login-sheet-mobile-input" />
          </div>
          <Button type="submit" size="lg" className="w-full font-bold" disabled={busy || !parsed.ok} data-testid="login-sheet-mobile-send">
            {busy ? "Sending…" : status && !status.smsAvailable ? "Save mobile number" : "Send code"}
          </Button>
        </form>
      )}
    </div>
  );
}
