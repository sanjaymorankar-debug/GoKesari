"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, inputClass } from "@/components/ui";
import { rupeesToPaise } from "@/lib/money";

/**
 * Administrator's manual shop wallet entry (a recharge paid outside the
 * gateway, or a correction). It is written as a ledger entry; a debit never
 * overdraws; the shop's owner is told. One request id per form, so a double
 * click adjusts once.
 */
export function ShopWalletAdjustForm({ shopId }: { shopId: string }) {
  const router = useRouter();
  const [direction, setDirection] = useState<"CREDIT" | "DEBIT">("CREDIT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    const rupees = Number(amount);
    if (!Number.isFinite(rupees) || rupees <= 0) {
      setMessage({ ok: false, text: "Enter a valid amount." });
      return;
    }
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/shops/${shopId}/wallet/adjust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction, amountPaise: rupeesToPaise(rupees), reason, requestId }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setMessage({ ok: false, text: payload?.error?.message ?? "The adjustment failed." });
      return;
    }
    setMessage({ ok: true, text: "Recorded." });
    setAmount("");
    setReason("");
    setRequestId(crypto.randomUUID());
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={`${inputClass} w-28`}
        value={direction}
        aria-label="Credit or debit"
        onChange={(e) => setDirection(e.target.value as "CREDIT" | "DEBIT")}
      >
        <option value="CREDIT">Credit</option>
        <option value="DEBIT">Debit</option>
      </select>
      <input
        className={`${inputClass} w-28`}
        inputMode="decimal"
        placeholder="₹"
        aria-label="Amount in rupees"
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
      />
      <input
        className={`${inputClass} min-w-0 flex-1`}
        placeholder="Reason (e.g. cash recharge, receipt 123)"
        aria-label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button size="sm" disabled={busy || reason.trim().length < 3 || !amount} onClick={() => void submit()}>
        {busy ? "Saving…" : "Record"}
      </Button>
      {message ? <span className={`text-xs ${message.ok ? "text-leaf-700" : "text-red-700"}`}>{message.text}</span> : null}
    </div>
  );
}
