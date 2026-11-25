"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, inputClass } from "@/components/ui";
import { openCashfreeCheckout } from "@/lib/cashfree-checkout";
import { formatPaiseCompact } from "@/lib/money";
import { parseRupeeInput } from "@/lib/rupee-input";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6: Hindi / Marathi (English unchanged). */
const T = {
  wrong: L("Something went wrong.", "कुछ गड़बड़ हो गई।", "काहीतरी चुकले."),
  added: L("{amount} added to your shop wallet.", "{amount} आपके दुकान वॉलेट में जुड़ गए।", "{amount} तुमच्या दुकान वॉलेटमध्ये जमा झाले."),
  invalid: L("Enter a valid amount.", "सही रकम लिखें।", "योग्य रक्कम लिहा."),
  title: L("Recharge wallet", "वॉलेट रिचार्ज करें", "वॉलेट रिचार्ज करा"),
  range: L(
    "Between {min} and {max} per recharge. Paid by UPI, card or netbanking.",
    "हर रिचार्ज {min} से {max} के बीच। UPI, कार्ड या नेटबैंकिंग से भुगतान।",
    "प्रत्येक रिचार्ज {min} ते {max} दरम्यान. UPI, कार्ड किंवा नेटबँकिंगने पेमेंट.",
  ),
  other: L("Other amount (₹)", "दूसरी रकम (₹)", "इतर रक्कम (₹)"),
  amountAria: L("Recharge amount in rupees", "रिचार्ज की रकम (रुपये)", "रिचार्जची रक्कम (रुपये)"),
  working: L("Working…", "हो रहा है…", "सुरू आहे…"),
  recharge: L("Recharge", "रिचार्ज", "रिचार्ज"),
} as const;

const PRESETS_PAISE = [50_000, 100_000, 200_000, 500_000];

/**
 * Shop wallet recharge. Same gateway flow as the customer wallet: the server
 * creates the payment, Cashfree takes it, and only the server's own check with
 * Cashfree credits the wallet. In mock mode (no gateway keys, never on
 * production) the payment is settled through the mock verifier instead.
 */
export function ShopWalletTopUp({
  shopId,
  minPaise,
  maxPaise,
  lang = "en",
}: {
  shopId: string;
  minPaise: number;
  maxPaise: number;
  /** Module 6: the board language (English by default). */
  lang?: Lang;
}) {
  const router = useRouter();
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function post(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorText(payload?.error?.message ?? tr(T.wrong, lang), lang, payload?.error?.code));
    return payload;
  }

  async function recharge(amountPaise: number) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const intent = await post(`/api/shops/${shopId}/wallet/topup`, { amountPaise });
      if (intent.mock) {
        await post("/api/dev/settle-topup", { gatewayOrderId: intent.gatewayOrderId });
      } else {
        await openCashfreeCheckout({ paymentSessionId: intent.paymentSessionId, orderId: intent.gatewayOrderId }, intent.cashfreeMode);
        await post(`/api/shops/${shopId}/wallet/verify`, { gatewayOrderId: intent.gatewayOrderId });
      }
      setNotice(tr(T.added, lang).replace("{amount}", formatPaiseCompact(amountPaise)));
      setCustom("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(T.wrong, lang));
    } finally {
      setBusy(false);
    }
  }

  function rechargeCustom() {
    // TC-FLD-030 (same as the customer wallet): at most two decimals — never rounded and charged.
    const parsed = parseRupeeInput(custom);
    if (parsed.ok !== true || parsed.paise <= 0) {
      setError(parsed.ok === false ? errorText(parsed.error, lang) : tr(T.invalid, lang));
      return;
    }
    void recharge(parsed.paise);
  }

  return (
    <Card className="p-5" data-testid="shop-wallet-topup">
      <h2 className="text-base font-semibold text-ink-900">{tr(T.title, lang)}</h2>
      <p className="mt-1 text-xs text-ink-500">
        {tr(T.range, lang).replace("{min}", formatPaiseCompact(minPaise)).replace("{max}", formatPaiseCompact(maxPaise))}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS_PAISE.filter((p) => p >= minPaise && p <= maxPaise).map((amount) => (
          <Button key={amount} variant="secondary" size="sm" disabled={busy} onClick={() => void recharge(amount)}>
            {formatPaiseCompact(amount)}
          </Button>
        ))}
      </div>
      <div className="mt-3 flex max-w-sm gap-2">
        <input
          className={inputClass}
          inputMode="decimal"
          placeholder={tr(T.other, lang)}
          aria-label={tr(T.amountAria, lang)}
          value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))}
        />
        <Button disabled={busy || !custom} onClick={rechargeCustom}>
          {busy ? tr(T.working, lang) : tr(T.recharge, lang)}
        </Button>
      </div>
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      {notice ? (
        <div className="mt-3">
          <Alert tone="success">{notice}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
