"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Money, inputClass } from "@/components/ui";
import { openCashfreeCheckout } from "@/lib/cashfree-checkout";
import { TOPUP_PRESETS_PAISE, formatPaiseCompact, rupeesToPaise } from "@/lib/money";
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

/** Wallet screen per requirements §19, §20, §24, §37, and Part B (§18–§20). */
export function WalletView({
  balancePaise,
  promotionalBalancePaise,
  lowBalanceThresholdPaise,
  todaysDeductionPaise,
  forecast,
  transactions,
}: {
  balancePaise: number;
  promotionalBalancePaise: number;
  lowBalanceThresholdPaise: number;
  todaysDeductionPaise: number;
  forecast: WalletForecast;
  transactions: Transaction[];
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
      setVoucherError("Enter a voucher code.");
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
        throw new Error(payload?.error?.message ?? "That voucher could not be applied.");
      }
      setVoucherPreview(payload);
    } catch (caught) {
      setVoucherError(caught instanceof Error ? caught.message : "That voucher could not be applied.");
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
        throw new Error(intent?.error?.message ?? "Could not start the payment.");
      }

      if (intent.mock) {
        const settleResponse = await fetch("/api/dev/settle-topup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gatewayOrderId: intent.gatewayOrderId }),
        });
        const settled = await settleResponse.json();
        if (!settleResponse.ok) {
          throw new Error(settled?.error?.message ?? "Payment could not be verified.");
        }
        setNotice(topUpSuccessMessage(amountPaise, settled.voucherBonusPaise));
        setCustom("");
        setVoucherCode("");
        setVoucherPreview(null);
        router.refresh();
        return;
      }

      // Live gateway: open the actual Cashfree widget and wait for it to
      // close (payment completed or cancelled), then ask the server to
      // independently confirm with Cashfree whether it was actually paid.
      await openCashfreeCheckout(
        { paymentSessionId: intent.paymentSessionId },
        intent.cashfreeMode,
      );
      const verifyResponse = await fetch("/api/wallet/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gatewayOrderId: intent.gatewayOrderId }),
      });
      const verified = await verifyResponse.json();
      if (!verifyResponse.ok) {
        throw new Error(verified?.error?.message ?? "Payment could not be verified.");
      }

      setNotice(topUpSuccessMessage(amountPaise, verified.voucherBonusPaise));
      setCustom("");
      setVoucherCode("");
      setVoucherPreview(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function topUpSuccessMessage(amountPaise: number, bonusPaise: number): string {
    if (bonusPaise > 0) {
      return `${formatPaiseCompact(amountPaise)} added, plus a ${formatPaiseCompact(bonusPaise)} voucher bonus.`;
    }
    return `${formatPaiseCompact(amountPaise)} added to your wallet.`;
  }

  function addCustom() {
    const rupees = Number(custom);
    if (!Number.isFinite(rupees) || rupees <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    addMoney(rupeesToPaise(rupees));
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-6">
        <Card className="p-6">
          <p className="text-sm text-ink-500">Available balance</p>
          <p className="mt-1 text-4xl font-bold text-ink-900">
            <Money paise={balancePaise} />
          </p>
          {promotionalBalancePaise > 0 ? (
            <p className="mt-1 text-xs text-ink-500">
              <Money paise={balancePaise - promotionalBalancePaise} /> from your
              payments · <Money paise={promotionalBalancePaise} /> voucher
              credit
            </p>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-cream-50 p-3">
              <p className="text-ink-500">Today&apos;s deduction</p>
              <p className="mt-0.5 font-semibold text-ink-900">
                <Money paise={todaysDeductionPaise} />
              </p>
            </div>
            <div className="rounded-lg bg-cream-50 p-3">
              <p className="text-ink-500">
                Next {forecast.horizonDays} days of subscriptions
              </p>
              <p className="mt-0.5 font-semibold text-ink-900">
                <Money paise={forecast.upcomingCostPaise} />
              </p>
            </div>
          </div>

          {isLow ? (
            <div className="mt-4">
              <Alert tone="warning" title="Low balance">
                Your balance is below your{" "}
                <Money paise={lowBalanceThresholdPaise} /> reminder threshold.
              </Alert>
            </div>
          ) : null}

          {!forecast.sufficient ? (
            <div className="mt-3">
              <Alert tone="danger" title="Upcoming subscriptions may not be covered">
                Your wallet may be insufficient for the next{" "}
                {forecast.horizonDays} days. We recommend adding{" "}
                <Money paise={forecast.recommendedTopUpPaise} />.
                <div className="mt-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => addMoney(forecast.recommendedTopUpPaise)}
                  >
                    Add {formatPaiseCompact(forecast.recommendedTopUpPaise)}
                  </Button>
                </div>
              </Alert>
            </div>
          ) : null}
        </Card>

        <Card id="history" className="p-6">
          <h2 className="mb-3 text-base font-semibold text-ink-900">
            Transactions
          </h2>
          {transactions.length === 0 ? (
            <p className="text-sm text-ink-500">No transactions yet.</p>
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
                      {new Date(t.createdAt).toLocaleString("en-IN", {
                        dateStyle: "medium",
                        timeStyle: "short",
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
                    <p className="text-xs text-ink-400">
                      bal <Money paise={t.newBalancePaise} />
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="lg:sticky lg:top-24 lg:self-start">
        <Card id="add-money" className="p-5">
          <h2 className="text-base font-semibold text-ink-900">Add money</h2>

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
              inputMode="numeric"
              placeholder="Amount (₹)"
              aria-label="Amount in rupees"
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
              placeholder="Voucher code (optional)"
              aria-label="Voucher code"
              className={inputClass}
            />
            <Button
              variant="secondary"
              disabled={voucherBusy || !custom}
              onClick={() => {
                const rupees = Number(custom);
                if (!Number.isFinite(rupees) || rupees <= 0) {
                  setVoucherError("Enter an amount first.");
                  return;
                }
                applyVoucher(rupeesToPaise(rupees));
              }}
            >
              Apply
            </Button>
          </div>
          {voucherError ? (
            <p className="mt-1 text-xs text-red-600">{voucherError}</p>
          ) : null}
          {voucherPreview ? (
            <div className="mt-2 rounded-lg bg-leaf-50 p-3 text-sm">
              <p className="font-medium text-leaf-800">{voucherPreview.name}</p>
              <div className="mt-1 flex justify-between text-ink-700">
                <span>Top-up</span>
                <Money paise={voucherPreview.totalCreditPaise - voucherPreview.bonusAmountPaise} />
              </div>
              <div className="flex justify-between text-leaf-700">
                <span>Voucher bonus ({voucherPreview.bonusPercent}%)</span>
                <Money paise={voucherPreview.bonusAmountPaise} />
              </div>
              <div className="mt-1 flex justify-between border-t border-leaf-200 pt-1 font-semibold text-ink-900">
                <span>Total wallet credit</span>
                <Money paise={voucherPreview.totalCreditPaise} />
              </div>
            </div>
          ) : null}

          <Button className="mt-3 w-full" disabled={busy || !custom} onClick={addCustom}>
            {busy ? "Processing…" : "Proceed to payment"}
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
            Payments are processed by Cashfree. Your wallet is credited only
            after the payment is verified.
          </p>
        </Card>
      </div>
    </div>
  );
}
