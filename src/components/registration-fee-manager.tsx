"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, EmptyState, Money, inputClass } from "@/components/ui";
import { rupeesToPaise } from "@/lib/money";

interface FeeRow {
  id: string;
  amountPaise: number;
  effectiveFrom: string;
  isActive: boolean;
}

interface HistoryRow {
  id: string;
  previousAmountPaise: number | null;
  newAmountPaise: number;
  effectiveFrom: string;
  reason: string | null;
  createdAt: string;
}

/**
 * Registration fee configuration (§12). ADMIN only.
 *
 * The copy states the immutability rule outright, because it is the single most
 * consequential thing about this screen: raising the fee here does not re-bill
 * anybody who already registered.
 */
export function RegistrationFeeManager({
  active,
  history,
}: {
  active: FeeRow | null;
  history: HistoryRow[];
}) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const rupees = Number(amount.replace(/[₹,\s]/g, ""));
    if (!Number.isFinite(rupees) || rupees < 0 || amount.trim() === "") {
      setError("Enter a valid fee amount in rupees.");
      return;
    }
    const paise = rupeesToPaise(rupees);
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/registration-fees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountPaise: paise,
          effectiveFrom: effectiveFrom || undefined,
          reason: reason || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "That did not work.");
      }
      setNotice("Registration fee updated. Existing shops are unaffected.");
      setAmount("");
      setReason("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger" title="Could not save">{error}</Alert> : null}
      {notice ? <Alert tone="success" title="Saved">{notice}</Alert> : null}

      <Card className="p-4">
        <p className="text-xs text-ink-500">Current registration fee (before GST)</p>
        <p className="mt-1 text-3xl font-bold text-ink-900">
          {active ? <Money paise={active.amountPaise} /> : "Not configured"}
        </p>
        {active ? (
          <p className="mt-1 text-xs text-ink-500">
            In force since{" "}
            {new Date(active.effectiveFrom).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
          </p>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs text-ink-500">New fee (₹, before GST)</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="999"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">Effective from</span>
            <input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">Reason</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Annual revision"
              className={inputClass}
            />
          </label>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <Button disabled={busy} onClick={submit}>
            Update fee
          </Button>
          <p className="text-xs text-ink-500">
            Only shops registering on or after the effective date pay the new
            amount, plus GST (Admin → Statutory). Shops already registered keep
            the fee they were charged.
          </p>
        </div>
      </Card>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-ink-900">
          Fee history ({history.length})
        </h3>
        {history.length === 0 ? (
          <EmptyState title="No fee changes recorded yet." />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-cream-100 text-xs uppercase text-ink-500">
                <tr>
                  <th className="px-4 py-2">Changed</th>
                  <th className="px-4 py-2">Old fee</th>
                  <th className="px-4 py-2">New fee</th>
                  <th className="px-4 py-2">Effective from</th>
                  <th className="px-4 py-2">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="px-4 py-2">
                      {new Date(h.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
                    </td>
                    <td className="px-4 py-2">
                      {h.previousAmountPaise != null ? (
                        <Money paise={h.previousAmountPaise} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2 font-medium text-ink-900">
                      <Money paise={h.newAmountPaise} />
                    </td>
                    <td className="px-4 py-2">
                      {new Date(h.effectiveFrom).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
                    </td>
                    <td className="px-4 py-2 text-ink-500">{h.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </div>
  );
}
