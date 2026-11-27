"use client";

import { useEffect, useState, type ReactNode } from "react";

import { useSignInConsent } from "@/components/signin-consent";
import { EMAIL_HINT, isValidEmail, parseIndianMobile } from "@/lib/contact";
import { SmsSecondFactor } from "@/components/sms-second-factor";
import type { SecondFactorPrompt } from "@/server/otp/second-factor";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6 (docs/hindi-marathi-2026-11): the code sign-in wording. */
const T = {
  sendFailed: L("Could not send a code. Please try again.", "कोड नहीं भेजा जा सका। फिर कोशिश करें।", "कोड पाठवता आला नाही. पुन्हा प्रयत्न करा."),
  unreachable: L(
    "Could not reach the server. Please try again.",
    "सर्वर से संपर्क नहीं हो सका। फिर कोशिश करें।",
    "सर्व्हरशी संपर्क झाला नाही. पुन्हा प्रयत्न करा.",
  ),
  tickAgree: L("Tick “I agree” above to continue.", "आगे बढ़ने के लिए ऊपर “मैं सहमत हूँ” पर टिक करें।", "पुढे जाण्यासाठी वर “मी सहमत आहे” वर टिक करा."),
  emailHint: L(
    "Enter a valid email address, e.g. name@example.com.",
    "सही ईमेल पता डालें, जैसे name@example.com।",
    "योग्य ईमेल पत्ता टाका, उदा. name@example.com.",
  ),
  mobileHint: L(
    "Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.",
    "6, 7, 8 या 9 से शुरू होने वाला 10 अंकों का भारतीय मोबाइल नंबर डालें।",
    "6, 7, 8 किंवा 9 ने सुरू होणारा 10 अंकी भारतीय मोबाइल नंबर टाका.",
  ),
  orEmail: L("Or enter your email address.", "या अपना ईमेल पता डालें।", "किंवा तुमचा ईमेल पत्ता टाका."),
  enterCode: L("Enter the code we sent you.", "हमारा भेजा कोड डालें।", "आम्ही पाठवलेला कोड टाका."),
  heading: L("Login with mobile number or email", "मोबाइल नंबर या ईमेल से लॉग इन करें", "मोबाइल नंबर किंवा ईमेलने लॉग इन करा"),
  idPlaceholder: L("10-digit mobile number or email", "10 अंकों का मोबाइल नंबर या ईमेल", "10 अंकी मोबाइल नंबर किंवा ईमेल"),
  idLabel: L("Mobile number or email", "मोबाइल नंबर या ईमेल", "मोबाइल नंबर किंवा ईमेल"),
  sending: L("Sending…", "भेज रहे हैं…", "पाठवत आहे…"),
  getCode: L("Get code", "कोड पाएँ", "कोड मिळवा"),
  codeByEmail: L(
    "With a mobile number the sign-in code comes by SMS; with an email it comes by email.",
    "मोबाइल नंबर से साइन इन कोड SMS से आता है; ईमेल से, ईमेल पर।",
    "मोबाइल नंबरने साइन इन कोड SMS ने येतो; ईमेलने, ईमेलवर.",
  ),
  enterEmail: L(
    "Enter your email address. We'll send the code there and link +91 {mobile} to your account.",
    "अपना ईमेल पता डालें। हम कोड वहीं भेजेंगे और +91 {mobile} को आपके खाते से जोड़ देंगे।",
    "तुमचा ईमेल पत्ता टाका. आम्ही कोड तिथे पाठवू आणि +91 {mobile} तुमच्या खात्याशी जोडू.",
  ),
  emailLabel: L("Email address", "ईमेल पता", "ईमेल पत्ता"),
  sendCode: L("Send code", "कोड भेजें", "कोड पाठवा"),
  changeNumber: L("Change number", "नंबर बदलें", "नंबर बदला"),
  otpSent: L("OTP sent to your email", "OTP आपके ईमेल पर भेजा गया", "OTP तुमच्या ईमेलवर पाठवला"),
  otpSentMobile: L(
    "OTP sent by SMS to +91 {mobile}. If SMS is not available right now, an existing account gets it at its email address.",
    "OTP SMS से +91 {mobile} पर भेजा गया। अगर अभी SMS उपलब्ध नहीं है, तो मौजूदा खाते के ईमेल पर भेजा जाता है।",
    "OTP SMS ने +91 {mobile} वर पाठवला. आत्ता SMS उपलब्ध नसल्यास, असलेल्या खात्याच्या ईमेलवर पाठवला जातो.",
  ),
  codePlaceholder: L("Enter code", "कोड डालें", "कोड टाका"),
  codeLabel: L("One-time code", "एक बार का कोड", "एक-वेळ कोड"),
  checking: L("Checking…", "जाँच रहे हैं…", "तपासत आहे…"),
  signIn: L("Sign in", "साइन इन", "साइन इन"),
  resendIn: L("Resend code in {n}s", "{n} सेकंड में कोड फिर भेजें", "{n} सेकंदांत कोड पुन्हा पाठवा"),
  resend: L("Resend code", "कोड फिर भेजें", "कोड पुन्हा पाठवा"),
  different: L("Use a different number or email", "दूसरा नंबर या ईमेल डालें", "दुसरा नंबर किंवा ईमेल वापरा"),
  noSms: L("No SMS after a minute?", "एक मिनट बाद भी SMS नहीं आया?", "एका मिनिटानंतरही SMS आला नाही?"),
  useEmail: L("Use your email instead", "इसकी जगह अपना ईमेल इस्तेमाल करें", "त्याऐवजी तुमचा ईमेल वापरा"),
} as const;

type Step = "identify" | "email" | "code" | "sms";
export type VerifyLoginCode = (input: {
  mobile: string | null;
  email: string | null;
  code: string;
  /** The Terms & Privacy box: the server creates a new account only when it is ticked (TC-FLD-004). */
  acceptedTerms: boolean;
  /** docs/sms-2fa-2026-11: the SMS step, when the account needs a second factor. */
}) => Promise<{ error?: string; secondFactor?: SecondFactorPrompt } | void>;

const inputClass =
  "min-w-0 rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none";
const buttonClass =
  "min-h-11 rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800 disabled:bg-cream-200 disabled:text-ink-600";

/**
 * One box: mobile number or email → one-time code (owner, 27-Nov-2026). A mobile number always gets its code by
 * SMS — a new number signs up that way (#665); an email gets its code by email. Verification is a server action that opens the session. `consent`, when given, is the
 * "I agree" box, shown between the field and the button.
 */
export function OtpLoginForm({ verify, lang = "en", consent }: { verify: VerifyLoginCode; lang?: Lang; consent?: ReactNode }) {
  const emailHint = lang === "en" ? EMAIL_HINT : tr(T.emailHint, lang);
  const [step, setStep] = useState<Step>("identify");
  const [identifier, setIdentifier] = useState("");
  const agreed = useSignInConsent();
  const [mobile, setMobile] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  /** Where the code went: the email given, masked, or null for "the account's email, if registered". */
  const [sentTo, setSentTo] = useState<string | null>(null);
  /** docs/sms-2fa-2026-11: the SMS step's prompt once the emailed code is right. */
  const [secondFactor, setSecondFactor] = useState<SecondFactorPrompt | null>(null);
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
        setError(body?.error?.message != null ? errorText(body.error.message, lang, body.error.code) : tr(T.sendFailed, lang));
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
      setError(tr(T.unreachable, lang));
    } finally {
      setBusy(false);
    }
  }

  function submitIdentifier(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    // The button is disabled until then; this also covers a form submitted another way (TC-FLD-004).
    if (!agreed) return setError(tr(T.tickAgree, lang));
    const value = identifier.trim();
    if (value.includes("@")) {
      if (!isValidEmail(value)) return setError(emailHint);
      void requestCode({ mobile: null, email: value });
      return;
    }
    const parsed = parseIndianMobile(value);
    if (!parsed.ok)
      return setError(
        lang === "en" ? `${parsed.error} Or enter your email address.` : `${tr(T.mobileHint, lang)} ${tr(T.orEmail, lang)}`,
      );
    void requestCode({ mobile: parsed.national, email: null });
  }

  function submitEmail(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!isValidEmail(emailInput)) return setError(emailHint);
    void requestCode({ mobile, email: emailInput.trim() });
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{4,8}$/.test(code.trim())) return setError(tr(T.enterCode, lang));
    setBusy(true);
    setError(null);
    const result = await verify({ mobile, email, code: code.trim(), acceptedTerms: agreed });
    // On success the server action redirects and never returns here — unless the SMS step comes next.
    if (result?.error) setError(errorText(result.error, lang));
    else if (result?.secondFactor) {
      setSecondFactor(result.secondFactor);
      setStep("sms");
    }
    setBusy(false);
  }

  function startOver() {
    setSecondFactor(null);
    setStep("identify");
    setCode("");
    setEmailInput("");
    setMobile(null);
    setEmail(null);
    setError(null);
  }

  return (
    <div className={consent ? "mt-6" : "mt-6 border-t border-cream-200 pt-6"} data-testid="otp-signin">
      <p className="mb-2 text-sm font-medium text-ink-700">{tr(T.heading, lang)}</p>

      {step === "identify" ? (
        <form onSubmit={submitIdentifier}>
          {consent ? (
            <>
              {/* One box, then "I agree", then the button (owner, 27-Nov-2026). */}
              <input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoComplete="username"
                autoFocus
                placeholder={tr(T.idPlaceholder, lang)}
                aria-label={tr(T.idLabel, lang)}
                className={`${inputClass} min-h-11 w-full text-base`}
                required
              />
              {consent}
              <button type="submit" disabled={busy || !agreed} className={`${buttonClass} mt-3 w-full`}>
                {busy ? tr(T.sending, lang) : tr(T.getCode, lang)}
              </button>
            </>
          ) : (
            <div className="flex gap-2">
              <input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoComplete="username"
                placeholder={tr(T.idPlaceholder, lang)}
                aria-label={tr(T.idLabel, lang)}
                className={`${inputClass} min-h-11 flex-1 text-base`}
                required
              />
              <button type="submit" disabled={busy || !agreed} className={buttonClass}>
                {busy ? tr(T.sending, lang) : tr(T.getCode, lang)}
              </button>
            </div>
          )}
          {/* Why the button cannot be used yet (it used to just look faded). */}
          {!agreed ? <p className="mt-2 text-sm font-medium text-ink-700">{tr(T.tickAgree, lang)}</p> : null}
          <p className="mt-2 text-sm text-ink-600">{tr(T.codeByEmail, lang)}</p>
        </form>
      ) : null}

      {step === "email" ? (
        <form onSubmit={submitEmail}>
          <p className="mb-2 text-sm text-ink-600">
            {tr(T.enterEmail, lang).replace("{mobile}", mobile ?? "")}
          </p>
          <div className="flex gap-2">
            <input
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              aria-label={tr(T.emailLabel, lang)}
              className={`${inputClass} flex-1`}
              required
            />
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? tr(T.sending, lang) : tr(T.sendCode, lang)}
            </button>
          </div>
          <button type="button" className="mt-2 text-xs underline" onClick={startOver}>
            {tr(T.changeNumber, lang)}
          </button>
        </form>
      ) : null}

      {step === "code" ? (
        <form onSubmit={submitCode}>
          <p className="mb-2 text-sm text-ink-600" data-testid="otp-sent-to">
            {sentTo ? (
              <>
                {tr(T.otpSent, lang)} <strong>{sentTo}</strong>.
              </>
            ) : (
              <>
                {tr(T.otpSentMobile, lang).replace("{mobile}", mobile ?? "")}
              </>
            )}
          </p>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={tr(T.codePlaceholder, lang)}
              aria-label={tr(T.codeLabel, lang)}
              maxLength={8}
              className={`${inputClass} flex-1 tracking-widest`}
              required
            />
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? tr(T.checking, lang) : tr(T.signIn, lang)}
            </button>
          </div>
          <div className="mt-2 flex gap-3 text-xs">
            <button
              type="button"
              className="underline disabled:no-underline disabled:opacity-50"
              disabled={busy || now < resendAt}
              onClick={() => requestCode({ mobile, email })}
            >
              {now < resendAt
                ? tr(T.resendIn, lang).replace("{n}", String(Math.ceil((resendAt - now) / 1000)))
                : tr(T.resend, lang)}
            </button>
            <button type="button" className="underline" onClick={startOver}>
              {tr(T.different, lang)}
            </button>
          </div>
          {sentTo === null ? (
            <p className="mt-3 text-xs text-ink-600">
              {tr(T.noSms, lang)}{" "}
              <button
                type="button"
                className="font-medium text-kesari-700 underline"
                onClick={() => {
                  setError(null);
                  setStep("email");
                }}
              >
                {tr(T.useEmail, lang)}
              </button>
            </p>
          ) : null}
        </form>
      ) : null}

      {step === "sms" && secondFactor ? <SmsSecondFactor prompt={secondFactor} onCancel={startOver} /> : null}

      {error && step !== "sms" ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
