"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { EmptyIllustration } from "@/components/empty-illustrations";
import { Alert, Button, Card, Money, inputClass } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";
import { HOME } from "@/lib/home-i18n";
import { openCashfreeCheckout } from "@/lib/cashfree-checkout";
import { TOPUP_PRESETS_PAISE, formatPaiseCompact } from "@/lib/money";
import { parseRupeeInput } from "@/lib/rupee-input";
import type { WalletForecast } from "@/server/services/subscriptions";

interface Transaction {
  id: string;
  type: string;
  amountPaise: number;
  newBalancePaise: number;
  description: string;
  createdAt: string;
}

interface VoucherPreview {
  code: string;
  name: string;
  bonusPercent: number;
  bonusAmountPaise: number;
  totalCreditPaise: number;
}

/** Module 6 (docs/hindi-marathi-2026-11): the wallet screen's wording. */
const T = {
  enterVoucher: L("Enter a voucher code.", "वाउचर कोड डालें।", "व्हाउचर कोड टाका."),
  voucherFailed: L("That voucher could not be applied.", "यह वाउचर नहीं लग सका।", "हा व्हाउचर लावता आला नाही."),
  addedBonus: L(
    "{amount} added, plus a {bonus} voucher bonus.",
    "{amount} जुड़ गए, साथ में {bonus} वाउचर बोनस।",
    "{amount} जमा झाले, सोबत {bonus} व्हाउचर बोनस.",
  ),
  added: L("{amount} added to your wallet.", "{amount} आपके वॉलेट में जुड़ गए।", "{amount} तुमच्या वॉलेटमध्ये जमा झाले."),
  validAmount: L("Enter a valid amount.", "सही रकम डालें।", "योग्य रक्कम टाका."),
  available: L("Available balance", "उपलब्ध बैलेंस", "उपलब्ध शिल्लक"),
  fromPayments: L("from your payments", "आपके भुगतान से", "तुमच्या पेमेंटमधून"),
  voucherCredit: L("voucher credit", "वाउचर क्रेडिट", "व्हाउचर क्रेडिट"),
  todaysDeduction: L("Today's deduction", "आज की कटौती", "आजची वजावट"),
  nextDays: L("Next {n} days of subscriptions", "अगले {n} दिनों के सब्सक्रिप्शन", "पुढील {n} दिवसांच्या सदस्यता"),
  lowBalance: L("Low balance", "बैलेंस कम है", "शिल्लक कमी आहे"),
  belowYour: L("Your balance is below your", "आपका बैलेंस आपकी", "तुमची शिल्लक तुमच्या"),
  reminder: L("reminder threshold.", "याद दिलाने की सीमा से कम है।", "आठवण मर्यादेपेक्षा कमी आहे."),
  notCovered: L("Upcoming subscriptions may not be covered", "आने वाले सब्सक्रिप्शन के लिए पैसे कम पड़ सकते हैं", "पुढील सदस्यतांसाठी पैसे कमी पडू शकतात"),
  insufficientFor: L(
    "Your wallet may be insufficient for the next {n} days. We recommend adding",
    "अगले {n} दिनों के लिए आपका वॉलेट कम पड़ सकता है। हमारा सुझाव है कि आप जोड़ें",
    "पुढील {n} दिवसांसाठी तुमचे वॉलेट कमी पडू शकते. आम्ही सुचवतो की तुम्ही भरा",
  ),
  addAmount: L("Add {amount}", "{amount} जोड़ें", "{amount} भरा"),
  transactions: L("Transactions", "लेन-देन", "व्यवहार"),
  bal: L("bal", "बैलेंस", "शिल्लक"),
  addMoney: L("Add money", "पैसे जोड़ें", "पैसे भरा"),
  amountPlaceholder: L("Amount (₹)", "रकम (₹)", "रक्कम (₹)"),
  amountLabel: L("Amount in rupees", "रुपये में रकम", "रुपयांमध्ये रक्कम"),
  voucherPlaceholder: L("Voucher code (optional)", "वाउचर कोड (वैकल्पिक)", "व्हाउचर कोड (ऐच्छिक)"),
  voucherLabel: L("Voucher code", "वाउचर कोड", "व्हाउचर कोड"),
  apply: L("Apply", "लगाएँ", "लावा"),
  topUp: L("Top-up", "टॉप-अप", "टॉप-अप"),
  voucherBonus: L("Voucher bonus", "वाउचर बोनस", "व्हाउचर बोनस"),
  totalCredit: L("Total wallet credit", "कुल वॉलेट क्रेडिट", "एकूण वॉलेट क्रेडिट"),
  processing: L("Processing…", "प्रोसेस हो रहा है…", "प्रक्रिया सुरू आहे…"),
  proceed: L("Proceed to payment", "भुगतान पर आगे बढ़ें", "पेमेंटकडे पुढे जा"),
  cashfreeNote: L(
    "Payments are processed by Cashfree. Your wallet is credited only after the payment is verified.",
    "भुगतान Cashfree से होता है। भुगतान की पुष्टि के बाद ही वॉलेट में पैसे जुड़ते हैं।",
    "पेमेंट Cashfree मार्फत होते. पेमेंट पडताळल्यानंतरच वॉलेटमध्ये पैसे जमा होतात.",
  ),
} as const;

/** Wallet screen per requirements §19, §20, §24, §37, and Part B (§18–§20). */
export function WalletView({
  balancePaise,
  promotionalBalancePaise,
  lowBalanceThresholdPaise,
  todaysDeductionPaise,
  forecast,
  transactions,
  lang = "en",
}: {
  balancePaise: number;
  promotionalBalancePaise: number;
  lowBalanceThresholdPaise: number;
  todaysDeductionPaise: number;
  forecast: WalletForecast;
  transactions: Transaction[];
  /** docs/homepage-uiux-2026-10: the empty history's wording. */
  lang?: Lang;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [voucherCode, setVoucherCode] = useState("");
  const [voucherPreview, setVoucherPreview] = useState<VoucherPreview | null>(null);
  const [voucherError, setVoucherError] = useState<string | null>(null);
  const [voucherBusy, setVoucherBusy] = useState(false);

  const isLow = balancePaise < lowBalanceThresholdPaise;

  /** §18: compute and show the bonus before any payment starts. */
  async function applyVoucher(amountPaise: number) {
    if (!voucherCode.trim()) {
      setVoucherError(tr(T.enterVoucher, lang));
      return;
    }
    setVoucherBusy(true);
    setVoucherError(null);
    setVoucherPreview(null);
    try {
      const response = await fetch("/api/vouchers/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: voucherCode.trim(), amountPaise }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(errorText(payload?.error?.message ?? "That voucher could not be applied.", lang, payload?.error?.code));
      }
      setVoucherPreview(payload);
    } catch (caught) {
      setVoucherError(caught instanceof Error ? caught.message : tr(T.voucherFailed, lang));
    } finally {
      setVoucherBusy(false);
    }
  }

  /**
   * Creates a gateway order then collects payment.
   *
   * Live credentials → opens the real Cashfree Checkout widget, then asks the
   * server to independently confirm payment with Cashfree. Mock mode (no
   * Cashfree credentials — dev/test only) asks the server for a signed
   * confirmation so the exact same verify-then-credit path still runs end to
   * end.
   */
  async function addMoney(amountPaise: number) {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const appliedVoucherCode =
        voucherPreview && voucherPreview.totalCreditPaise - voucherPreview.bonusAmountPaise === amountPaise
          ? voucherPreview.code
          : null;

      const createResponse = await fetch("/api/wallet/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountPaise, voucherCode: appliedVoucherCode }),
      });
      const intent = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(errorText(intent?.error?.message ?? "Could not start the payment.", lang, intent?.error?.code));
      }

      if (intent.mock) {
        const settleResponse = await fetch("/api/dev/settle-topup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gatewayOrderId: intent.gatewayOrderId }),
        });
        const settled = await settleResponse.json();
        if (!settleResponse.ok) {
          throw new Error(errorText(settled?.error?.message ?? "Payment could not be verified.", lang, settled?.error?.code));
        }
        setNotice(topUpSuccessMessage(amountPaise, settled.voucherBonusPaise));
        setCustom("");
        setVoucherCode("");
        setVoucherPreview(null);
        router.refresh();
        return;
      }

      // PAY-2: a top-up through a payment intent on a hosted page (e.g. the sandbox gateway).
      // The payment return page shows the result; the wallet is credited server-side.
      if (intent.redirectUrl && !intent.paymentSessionId) {
        window.location.assign(intent.redirectUrl);
        return;
      }

      // Live gateway: open the actual Cashfree widget and wait for it to
      // close (payment completed or cancelled), then ask the server to
      // independently confirm with Cashfree whether it was actually paid.
      await openCashfreeCheckout(
        { paymentSessionId: intent.paymentSessionId, orderId: intent.gatewayOrderId },
        intent.cashfreeMode,
      );
      const verifyResponse = await fetch("/api/wallet/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gatewayOrderId: intent.gatewayOrderId }),
      });
      const verified = await verifyResponse.json();
      if (!verifyResponse.ok) {
        throw new Error(errorText(verified?.error?.message ?? "Payment could not be verified.", lang, verified?.error?.code));
      }

      setNotice(topUpSuccessMessage(amountPaise, verified.voucherBonusPaise));
      setCustom("");
      setVoucherCode("");
      setVoucherPreview(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : errorText("Something went wrong.", lang));
    } finally {
      setBusy(false);
    }
  }

  function topUpSuccessMessage(amountPaise: number, bonusPaise: number): string {
    if (bonusPaise > 0) {
      return tr(T.addedBonus, lang)
        .replace("{amount}", formatPaiseCompact(amountPaise))
        .replace("{bonus}", formatPaiseCompact(bonusPaise));
    }
    return tr(T.added, lang).replace("{amount}", formatPaiseCompact(amountPaise));
  }

  /** TC-FLD-030: at most two decimals (paise) — 10.555 is refused with a message, not rounded and charged. */
  function typedPaise(onError: (message: string) => void): number | null {
    const parsed = parseRupeeInput(custom);
    if (parsed.ok === true && parsed.paise > 0) return parsed.paise;
    onError(parsed.ok === false ? parsed.error : tr(T.validAmount, lang));
    return null;
  }

  function addCustom() {
    const paise = typedPaise(setError);
    if (paise !== null) addMoney(paise);
  }

  return (
    // TC-PAY-002: the columns may shrink below their content (minmax(0, 1fr) and
    // min-w-0) — a long transaction description no longer widens the page
    // past a 360–412 px phone screen and pushes "Add money" off it.
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-6">
        <Card className="p-6">
          <p className="text-sm text-ink-500">{tr(T.available, lang)}</p>
          <p className="mt-1 text-4xl font-bold text-ink-900">
            <Money paise={balancePaise} />
          </p>
          {promotionalBalancePaise > 0 ? (
            <p className="mt-1 text-xs text-ink-500">
              <Money paise={balancePaise - promotionalBalancePaise} /> {tr(T.fromPayments, lang)}
              {" · "}<Money paise={promotionalBalancePaise} /> {tr(T.voucherCredit, lang)}
            </p>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-cream-50 p-3">
              <p className="text-ink-500">{tr(T.todaysDeduction, lang)}</p>
              <p className="mt-0.5 font-semibold text-ink-900">
                <Money paise={todaysDeductionPaise} />
              </p>
            </div>
            <div className="rounded-lg bg-cream-50 p-3">
              <p className="text-ink-500">
                {tr(T.nextDays, lang).replace("{n}", String(forecast.horizonDays))}
              </p>
              <p className="mt-0.5 font-semibold text-ink-900">
                <Money paise={forecast.upcomingCostPaise} />
              </p>
            </div>
          </div>

          {isLow ? (
            <div className="mt-4">
              <Alert tone="warning" title={tr(T.lowBalance, lang)}>
                {tr(T.belowYour, lang)}{" "}
                <Money paise={lowBalanceThresholdPaise} /> {tr(T.reminder, lang)}
              </Alert>
            </div>
          ) : null}

          {!forecast.sufficient ? (
            <div className="mt-3">
              <Alert tone="danger" title={tr(T.notCovered, lang)}>
                {tr(T.insufficientFor, lang).replace("{n}", String(forecast.horizonDays))}{" "}
                <Money paise={forecast.recommendedTopUpPaise} />.
                <div className="mt-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => addMoney(forecast.recommendedTopUpPaise)}
                  >
                    {tr(T.addAmount, lang).replace("{amount}", formatPaiseCompact(forecast.recommendedTopUpPaise))}
                  </Button>
                </div>
              </Alert>
            </div>
          ) : null}
        </Card>

        <Card id="history" className="p-6">
          <h2 className="mb-3 text-base font-semibold text-ink-900">
            {tr(T.transactions, lang)}
          </h2>
          {transactions.length === 0 ? (
            // docs/homepage-uiux-2026-10 (F3): a picture and the next step.
            <div className="py-2 text-center" data-testid="wallet-history-empty">
              <EmptyIllustration name="wallet" />
              <p className="mt-2 text-base font-bold text-ink-900">{tr(HOME.walletEmptyTitle, lang)}</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">{tr(HOME.walletEmptyText, lang)}</p>
              <a href="#add-money" className="mt-3 inline-flex h-11 items-center rounded-lg bg-kesari-600 px-4 text-sm font-medium text-white hover:bg-kesari-800">
                {tr(HOME.addMoney, lang)}
              </a>
            </div>
          ) : (
            <ul className="divide-y divide-cream-200">
              {transactions.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">
                      {t.description}
                    </p>
                    <p className="text-xs text-ink-500">
                      {t.type.replace(/_/g, " ").toLowerCase()} ·{" "}
                      {/* GAP-017: India time on the server too, or the server's UTC text mismatches the browser's (React #418). */}
                      {new Date(t.createdAt).toLocaleString("en-IN", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "Asia/Kolkata",
                      })}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={
                        t.amountPaise > 0
                          ? "font-semibold text-leaf-700"
                          : "font-semibold text-ink-900"
                      }
                    >
                      {t.amountPaise > 0 ? "+" : "−"}
                      <Money paise={Math.abs(t.amountPaise)} />
                    </p>
                    <p className="text-xs text-ink-500">
                      {tr(T.bal, lang)} <Money paise={t.newBalancePaise} />
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="min-w-0 lg:sticky lg:top-24 lg:self-start">
        <Card id="add-money" className="p-5">
          <h2 className="text-base font-semibold text-ink-900">{tr(T.addMoney, lang)}</h2>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {TOPUP_PRESETS_PAISE.map((paise) => (
              <Button
                key={paise}
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setCustom(String(paise / 100));
                  setVoucherPreview(null);
                }}
              >
                {formatPaiseCompact(paise)}
              </Button>
            ))}
          </div>

          <div className="mt-3">
            <input
              type="number"
              min={1}
              step={0.01}
              inputMode="decimal"
              placeholder={tr(T.amountPlaceholder, lang)}
              aria-label={tr(T.amountLabel, lang)}
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value);
                setVoucherPreview(null);
              }}
              className={inputClass}
            />
          </div>

          <div className="mt-2 flex gap-2">
            <input
              value={voucherCode}
              onChange={(e) => setVoucherCode(e.target.value.toUpperCase())}
              placeholder={tr(T.voucherPlaceholder, lang)}
              aria-label={tr(T.voucherLabel, lang)}
              className={`${inputClass} min-w-0`}
            />
            <Button
              variant="secondary"
              disabled={voucherBusy || !custom}
              onClick={() => {
                const paise = typedPaise(setVoucherError);
                if (paise !== null) applyVoucher(paise);
              }}
            >
              {tr(T.apply, lang)}
            </Button>
          </div>
          {voucherError ? (
            <p className="mt-1 text-xs text-red-600">{voucherError}</p>
          ) : null}
          {voucherPreview ? (
            <div className="mt-2 rounded-lg bg-leaf-50 p-3 text-sm">
              <p className="font-medium text-leaf-800">{voucherPreview.name}</p>
              <div className="mt-1 flex justify-between text-ink-700">
                <span>{tr(T.topUp, lang)}</span>
                <Money paise={voucherPreview.totalCreditPaise - voucherPreview.bonusAmountPaise} />
              </div>
              <div className="flex justify-between text-leaf-700">
                <span>{tr(T.voucherBonus, lang)} ({voucherPreview.bonusPercent}%)</span>
                <Money paise={voucherPreview.bonusAmountPaise} />
              </div>
              <div className="mt-1 flex justify-between border-t border-leaf-200 pt-1 font-semibold text-ink-900">
                <span>{tr(T.totalCredit, lang)}</span>
                <Money paise={voucherPreview.totalCreditPaise} />
              </div>
            </div>
          ) : null}

          <Button className="mt-3 w-full" disabled={busy || !custom} onClick={addCustom}>
            {busy ? tr(T.processing, lang) : tr(T.proceed, lang)}
          </Button>

          {notice ? (
            <div className="mt-3">
              <Alert tone="success">{notice}</Alert>
            </div>
          ) : null}
          {error ? (
            <div className="mt-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}

          <p className="mt-3 text-xs text-ink-500">
            {tr(T.cashfreeNote, lang)}
          </p>
        </Card>
      </div>
    </div>
  );
}
