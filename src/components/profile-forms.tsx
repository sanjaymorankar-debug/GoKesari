"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PersonalDetailsFields, type GenderValue } from "@/components/profile-setup";
import { Alert, Button, Field, inputClass } from "@/components/ui";
import { EMAIL_HINT, isValidEmail } from "@/lib/contact";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6 (docs/hindi-marathi-2026-11): My Profile's forms. */
const T = {
  detailsFailed: L("Could not save your details.", "आपकी जानकारी सहेजी नहीं जा सकी।", "तुमची माहिती जतन करता आली नाही."),
  saved: L("Saved.", "सहेज लिया।", "जतन केले."),
  saving: L("Saving…", "सहेज रहे हैं…", "जतन करत आहे…"),
  saveDetails: L("Save details", "जानकारी सहेजें", "माहिती जतन करा"),
  emailHint: L(
    "Enter a valid email address, e.g. name@example.com.",
    "सही ईमेल पता डालें, जैसे name@example.com।",
    "योग्य ईमेल पत्ता टाका, उदा. name@example.com.",
  ),
  sendFailed: L("Could not send the code.", "कोड नहीं भेजा जा सका।", "कोड पाठवता आला नाही."),
  confirmFailed: L("Could not confirm the code.", "कोड की पुष्टि नहीं हो सकी।", "कोड पडताळता आला नाही."),
  email: L("Email:", "ईमेल:", "ईमेल:"),
  changeEmail: L("Change email", "ईमेल बदलें", "ईमेल बदला"),
  emailUpdated: L("Email updated. Use it to sign in from now on.", "ईमेल बदल गया। अब से इसी से साइन इन करें।", "ईमेल बदलला. आतापासून याच ईमेलने साइन इन करा."),
  newEmail: L("New email address", "नया ईमेल पता", "नवीन ईमेल पत्ता"),
  newEmailHint: L(
    "We'll send a code to this address. Your email changes only after you enter it.",
    "हम इस पते पर एक कोड भेजेंगे। कोड डालने के बाद ही ईमेल बदलेगा।",
    "आम्ही या पत्त्यावर एक कोड पाठवू. कोड टाकल्यानंतरच ईमेल बदलेल.",
  ),
  sending: L("Sending…", "भेज रहे हैं…", "पाठवत आहे…"),
  sendCode: L("Send code", "कोड भेजें", "कोड पाठवा"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
  otpSent: L("OTP sent to your email", "OTP आपके ईमेल पर भेजा गया", "OTP तुमच्या ईमेलवर पाठवला"),
  enterBelow: L("Enter it below.", "इसे नीचे डालें।", "तो खाली टाका."),
  code: L("Code", "कोड", "कोड"),
  checking: L("Checking…", "जाँच रहे हैं…", "तपासत आहे…"),
  confirmEmail: L("Confirm new email", "नए ईमेल की पुष्टि करें", "नवीन ईमेल निश्चित करा"),
  resend: L("Resend code", "कोड फिर भेजें", "कोड पुन्हा पाठवा"),
  differentEmail: L("Use a different email", "दूसरा ईमेल डालें", "दुसरा ईमेल वापरा"),
} as const;

/** My Profile: name and gender. */
export function ProfileDetailsForm({
  initial,
  lang = "en",
}: {
  initial: { name: string; gender: GenderValue | "" };
  lang?: Lang;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [gender, setGender] = useState<GenderValue | "">(initial.gender);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() || null, gender: gender || null, markComplete: true }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok)
      return setStatus({
        tone: "danger",
        text: payload?.error?.message != null ? errorText(payload.error.message, lang, payload.error.code) : tr(T.detailsFailed, lang),
      });
    setStatus({ tone: "success", text: tr(T.saved, lang) });
    router.refresh();
  }

  return (
    <form onSubmit={save} className="grid gap-4" data-testid="profile-details-form">
      {status ? <Alert tone={status.tone}>{status.text}</Alert> : null}
      <PersonalDetailsFields name={name} setName={setName} gender={gender} setGender={setGender} lang={lang} />
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? tr(T.saving, lang) : tr(T.saveDetails, lang)}
        </Button>
      </div>
    </form>
  );
}

/** My Profile: change the sign-in email. A code goes to the NEW address and must be entered before it is saved. */
export function EmailChangeForm({ current, lang = "en" }: { current: string; lang?: Lang }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    setError(null);
    if (!isValidEmail(email)) return setError(lang === "en" ? EMAIL_HINT : tr(T.emailHint, lang));
    setBusy(true);
    const res = await fetch("/api/profile/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok)
      return setError(payload?.error?.message != null ? errorText(payload.error.message, lang, payload.error.code) : tr(T.sendFailed, lang));
    setSentTo(payload.maskedEmail);
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch("/api/profile/email", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok)
      return setError(payload?.error?.message != null ? errorText(payload.error.message, lang, payload.error.code) : tr(T.confirmFailed, lang));
    setDone(payload.email);
    setOpen(false);
    setSentTo(null);
    setCode("");
    setEmail("");
    router.refresh();
  }

  return (
    <div data-testid="email-change">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-700">
          <span className="font-medium">{tr(T.email, lang)}</span> {done ?? current}
        </p>
        {!open ? (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            {tr(T.changeEmail, lang)}
          </Button>
        ) : null}
      </div>
      {done ? <p className="mt-1 text-xs text-leaf-700">{tr(T.emailUpdated, lang)}</p> : null}
      {open ? (
        <div className="mt-3 grid gap-3 rounded-lg border border-cream-200 p-3">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {!sentTo ? (
            <form onSubmit={send} className="grid gap-2">
              <Field label={tr(T.newEmail, lang)} hint={tr(T.newEmailHint, lang)}>
                <input type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? tr(T.sending, lang) : tr(T.sendCode, lang)}
                </Button>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  {tr(T.cancel, lang)}
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={confirm} className="grid gap-2">
              <p className="text-sm text-ink-600">
                {tr(T.otpSent, lang)} <strong>{sentTo}</strong>. {tr(T.enterBelow, lang)}
              </p>
              <input
                className={`${inputClass} tracking-widest`}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                aria-label={tr(T.code, lang)}
                required
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? tr(T.checking, lang) : tr(T.confirmEmail, lang)}
                </Button>
                <Button variant="secondary" onClick={() => send()} disabled={busy}>
                  {tr(T.resend, lang)}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSentTo(null);
                    setCode("");
                  }}
                >
                  {tr(T.differentEmail, lang)}
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
