"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, inputClass } from "@/components/ui";
import { openCashfreeCheckout } from "@/lib/cashfree-checkout";
import { formatPaiseCompact, rupeesToPaise } from "@/lib/money";

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
}: {
  shopId: string;
  minPaise: number;
  maxPaise: number;
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
    if (!response.ok) throw new Error(payload?.error?.message ?? "Something went wrong.");
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
        await openCashfreeCheckout({ paymentSessionId: intent.paymentSessionId }, intent.cashfreeMode);
        await post(`/api/shops/${shopId}/wallet/verify`, { gatewayOrderId: intent.gatewayOrderId });
      }
      setNotice(`${formatPaiseCompact(amountPaise)} added to your shop wallet.`);
      setCustom("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function rechargeCustom() {
    const rupees = Number(custom);
    if (!Number.isFinite(rupees) || rupees <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    void recharge(rupeesToPaise(rupees));
  }

  return (
    <Card className="p-5" data-testid="shop-wallet-topup">
      <h2 className="text-base font-semibold text-ink-900">Recharge wallet</h2>
      <p className="mt-1 text-xs text-ink-500">
        Between {formatPaiseCompact(minPaise)} and {formatPaiseCompact(maxPaise)} per recharge. Paid by UPI, card or netbanking.
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
          placeholder="Other amount (₹)"
          aria-label="Recharge amount in rupees"
          value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))}
        />
        <Button disabled={busy || !custom} onClick={rechargeCustom}>
          {busy ? "Working…" : "Recharge"}
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
