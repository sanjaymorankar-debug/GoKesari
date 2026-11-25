"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";
import { formatPaise } from "@/lib/money";

const T = {
  generic: L("Something went wrong.", "कुछ गड़बड़ हो गई।", "काहीतरी चुकले."),
  enterAmount: L("Enter the amount to withdraw.", "निकालने की रकम डालें।", "काढायची रक्कम टाका."),
  checkFailed: L("Could not check the amount.", "रकम जाँची नहीं जा सकी।", "रक्कम तपासता आली नाही."),
  yourEmail: L("your email", "आपका ईमेल", "तुमचा ईमेल"),
  sendFailed: L("Could not send the code.", "कोड नहीं भेजा जा सका।", "कोड पाठवता आला नाही."),
  paid: L("{amount} has been paid to your bank.", "{amount} आपके बैंक में भेज दिए गए हैं।", "{amount} तुमच्या बँकेत पाठवले आहेत."),
  refused: L(
    "The bank refused the transfer: {reason} The amount is back in your balance.",
    "बैंक ने ट्रांसफ़र अस्वीकार किया: {reason} रकम आपके बैलेंस में वापस आ गई है।",
    "बँकेने ट्रान्सफर नाकारले: {reason} रक्कम तुमच्या शिलकीत परत आली आहे.",
  ),
  onItsWay: L("{amount} is on its way to your bank.", "{amount} आपके बैंक की ओर रास्ते में हैं।", "{amount} तुमच्या बँकेकडे वाटेत आहेत."),
  withdrawFailed: L("Could not withdraw.", "निकासी नहीं हो सकी।", "रक्कम काढता आली नाही."),
  amountLabel: L("Amount (₹)", "रकम (₹)", "रक्कम (₹)"),
  between: L("Between {min} and {max} today.", "आज {min} से {max} के बीच।", "आज {min} ते {max} दरम्यान."),
  amountAria: L("Amount to withdraw in rupees", "निकालने की रकम रुपये में", "काढायची रक्कम रुपयांत"),
  check: L("Check", "जाँचें", "तपासा"),
  amount: L("Amount", "रकम", "रक्कम"),
  fee: L("Fee", "शुल्क", "शुल्क"),
  none: L("None", "कोई नहीं", "काही नाही"),
  receive: L("You receive", "आपको मिलेंगे", "तुम्हाला मिळतील"),
  to: L("To", "भेजा जाएगा:", "पाठवले जाईल:"),
  yourBank: L("your bank account", "आपका बैंक खाता", "तुमचे बँक खाते"),
  code: L("Code", "कोड", "कोड"),
  emailed: L("We emailed a code to {to}.", "हमने {to} पर कोड ईमेल किया है।", "आम्ही {to} वर कोड ईमेल केला आहे."),
  codeAria: L("Confirmation code", "पुष्टि कोड", "खात्री कोड"),
  withdraw: L("Withdraw", "निकालें", "काढा"),
  emailMe: L("Email me a code to confirm", "पुष्टि के लिए मुझे कोड ईमेल करें", "खात्रीसाठी मला कोड ईमेल करा"),
} as const;

interface Quote {
  amountPaise: number;
  feePaise: number;
  tdsPaise: number;
  tdsRateBp: number;
  netPaise: number;
  settlement: string;
  account: string | null;
  problem: string | null;
}

/**
 * Withdraw unpaid earnings to the verified bank account
 * (docs/gig-bank-payouts-2026-10): amount → what will be paid (fee, TDS,
 * settlement time) → emailed code → withdraw.
 */
export function WithdrawPanel({
  availablePaise,
  minPaise,
  maxPaise,
  leftTodayPaise,
  lang = "en",
}: {
  availablePaise: number;
  minPaise: number;
  maxPaise: number;
  leftTodayPaise: number;
  lang?: Lang;
}) {
  const t = (text: Text) => tr(text, lang);
  const router = useRouter();
  const [rupees, setRupees] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const amountPaise = Math.round(Number(rupees.replace(/,/g, "")) * 100);
  const upTo = Math.min(availablePaise, maxPaise, leftTodayPaise);

  async function call(url: string, init?: RequestInit) {
    const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error?.message ? errorText(payload.error.message, lang, payload?.error?.code) : t(T.generic));
    }
    return payload;
  }

  async function check(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    setCodeSentTo(null);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) return setError(t(T.enterAmount));
    setBusy(true);
    try {
      setQuote(await call(`/api/gig/wallet/quote?amountPaise=${amountPaise}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t(T.checkFailed));
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const payload = await call("/api/gig/wallet/withdrawals", { method: "POST", body: JSON.stringify({ amountPaise }) });
      setCodeSentTo(payload.codeSent?.maskedEmail ?? t(T.yourEmail));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t(T.sendFailed));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const transfer = await call("/api/gig/wallet/withdrawals", { method: "POST", body: JSON.stringify({ amountPaise, code }) });
      setDone(
        transfer.status === "SUCCESS"
          ? t(T.paid).replace("{amount}", formatPaise(transfer.netPaise))
          : transfer.status === "RELEASED"
            ? t(T.refused).replace("{reason}", transfer.failureReason ?? "")
            : t(T.onItsWay).replace("{amount}", formatPaise(transfer.netPaise)),
      );
      setQuote(null);
      setCodeSentTo(null);
      setCode("");
      setRupees("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t(T.withdrawFailed));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <form onSubmit={check} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <Field
            label={t(T.amountLabel)}
            hint={t(T.between).replace("{min}", formatPaise(minPaise)).replace("{max}", formatPaise(upTo > 0 ? upTo : 0))}
          >
            <input
              className={inputClass}
              inputMode="decimal"
              value={rupees}
              onChange={(e) => {
                setRupees(e.target.value);
                setQuote(null);
                setCodeSentTo(null);
              }}
              placeholder="500"
              aria-label={t(T.amountAria)}
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={busy || !rupees}>
          {t(T.check)}
        </Button>
      </form>

      {quote ? (
        <div className="rounded-lg border border-cream-200 p-4 text-sm">
          <dl className="grid grid-cols-2 gap-y-1">
            <dt className="text-ink-500">{t(T.amount)}</dt>
            <dd className="text-right">{formatPaise(quote.amountPaise)}</dd>
            <dt className="text-ink-500">{t(T.fee)}</dt>
            <dd className="text-right">{quote.feePaise > 0 ? `− ${formatPaise(quote.feePaise)}` : t(T.none)}</dd>
            <dt className="text-ink-500">TDS {quote.tdsRateBp > 0 ? `(${quote.tdsRateBp / 100}%)` : ""}</dt>
            <dd className="text-right">{quote.tdsPaise > 0 ? `− ${formatPaise(quote.tdsPaise)}` : t(T.none)}</dd>
            <dt className="font-semibold text-ink-900">{t(T.receive)}</dt>
            <dd className="text-right font-semibold text-ink-900">{formatPaise(quote.netPaise)}</dd>
          </dl>
          <p className="mt-3 text-ink-500">
            {t(T.to)} {quote.account ?? t(T.yourBank)} — {quote.settlement}.
          </p>
          {quote.problem ? (
            <div className="mt-3">
              <Alert tone="warning">{errorText(quote.problem, lang)}</Alert>
            </div>
          ) : codeSentTo ? (
            <form onSubmit={confirm} className="mt-3 flex flex-wrap items-end gap-3">
              <div className="min-w-[10rem] flex-1">
                <Field label={t(T.code)} hint={t(T.emailed).replace("{to}", codeSentTo)}>
                  <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} aria-label={t(T.codeAria)} />
                </Field>
              </div>
              <Button type="submit" disabled={busy || code.trim().length < 4}>
                {t(T.withdraw)} {formatPaise(quote.netPaise)}
              </Button>
            </form>
          ) : (
            <div className="mt-3">
              <Button onClick={sendCode} disabled={busy}>
                {t(T.emailMe)}
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {done ? <Alert tone="success">{done}</Alert> : null}
    </Card>
  );
}
