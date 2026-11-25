"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

const T = {
  generic: L("Something went wrong.", "कुछ गड़बड़ हो गई।", "काहीतरी चुकले."),
  confirmed: L(
    "Confirmed. Change your bank details below (or remove the account) before",
    "पुष्टि हो गई। नीचे अपना बैंक विवरण बदलें (या खाता हटाएँ), इस समय से पहले:",
    "खात्री झाली. खाली तुमचे बँक तपशील बदला (किंवा खाते काढा), या वेळेपूर्वी:",
  ),
  verifiedIntro: L(
    "Your account is verified. To change or remove it, first confirm it's you with a code we email you.",
    "आपका खाता सत्यापित है। इसे बदलने या हटाने के लिए पहले ईमेल पर भेजे गए कोड से पुष्टि करें कि यह आप ही हैं।",
    "तुमचे खाते पडताळलेले आहे. ते बदलण्यासाठी किंवा काढण्यासाठी आधी ईमेलवर पाठवलेल्या कोडने हे तुम्हीच आहात याची खात्री करा.",
  ),
  yourEmail: L("your email", "आपका ईमेल", "तुमचा ईमेल"),
  emailMe: L("Email me a code", "मुझे कोड ईमेल करें", "मला कोड ईमेल करा"),
  code: L("Code", "कोड", "कोड"),
  sentTo: L("Sent to {to}.", "{to} पर भेजा गया।", "{to} वर पाठवला."),
  codeAria: L("Confirmation code", "पुष्टि कोड", "खात्री कोड"),
  confirm: L("Confirm", "पुष्टि करें", "खात्री करा"),
  removeConfirm: L(
    "Remove this bank account? Payouts stop until you add and verify another one.",
    "यह बैंक खाता हटाएँ? दूसरा खाता जोड़कर सत्यापित करने तक पेआउट रुके रहेंगे।",
    "हे बँक खाते काढायचे? दुसरे खाते जोडून पडताळेपर्यंत पेआउट थांबतील.",
  ),
  remove: L("Remove this bank account", "यह बैंक खाता हटाएँ", "हे बँक खाते काढा"),
} as const;

/**
 * A delivery partner confirms it's them (emailed code) before changing or
 * removing a verified bank account (docs/gig-bank-payouts-2026-10). The
 * change itself happens in the bank account form below, within 10 minutes.
 */
export function BankReauth({ canRemove, lang = "en" }: { canRemove: boolean; lang?: Lang }) {
  const t = (text: Text) => tr(text, lang);
  const router = useRouter();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [until, setUntil] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(url: string, method: string, body?: unknown) {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error?.message ? errorText(payload.error.message, lang, payload?.error?.code) : t(T.generic));
    }
    return payload;
  }

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t(T.generic));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-5">
      {until ? (
        <Alert tone="success">
          {t(T.confirmed)}{" "}
          {new Date(until).toLocaleTimeString("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" })}.
        </Alert>
      ) : (
        <p className="text-sm text-ink-600">{t(T.verifiedIntro)}</p>
      )}
      {!until && !sentTo ? (
        <Button variant="secondary" disabled={busy} onClick={() => run(async () => setSentTo((await post("/api/gig/bank-account/reauth", "POST", {})).codeSent?.maskedEmail ?? t(T.yourEmail)))}>
          {t(T.emailMe)}
        </Button>
      ) : null}
      {!until && sentTo ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => setUntil((await post("/api/gig/bank-account/reauth", "POST", { code })).expiresAt));
          }}
        >
          <div className="min-w-[10rem] flex-1">
            <Field label={t(T.code)} hint={t(T.sentTo).replace("{to}", sentTo)}>
              <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} aria-label={t(T.codeAria)} />
            </Field>
          </div>
          <Button type="submit" disabled={busy || code.trim().length < 4}>
            {t(T.confirm)}
          </Button>
        </form>
      ) : null}
      {until && canRemove ? (
        <Button
          variant="danger"
          size="sm"
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (!window.confirm(t(T.removeConfirm))) return;
              await post("/api/gig/bank-account", "DELETE");
              setUntil(null);
              setSentTo(null);
              router.refresh();
            })
          }
        >
          {t(T.remove)}
        </Button>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}
