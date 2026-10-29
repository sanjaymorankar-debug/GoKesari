"use client";

/**
 * Admin → Dealers → one dealer: this dealer's own base commission % and change
 * per rating point (owner, 29 Oct 2026). Empty = the default for every dealer
 * (Admin → Dealers → Commission). Only an admin changes it; every change asks
 * for a reason and is audited. Applies to commission earned from now on.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { pct, toBp } from "@/components/dealer/commission-admin";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

export interface DealerRateProps {
  dealerId: string;
  isAdmin: boolean;
  model: "BASE_PERCENT" | "MILESTONE_RULES";
  /** This dealer's own values, or null for the default. */
  ownBasePercentBp: number | null;
  ownRatingStepBp: number | null;
  defaults: { basePercentBp: number; ratingStepBp: number };
  rating: number;
  ratingOn: boolean;
}

export function DealerCommissionRates({ dealerId, isAdmin, model, ownBasePercentBp, ownRatingStepBp, defaults, rating, ratingOn }: DealerRateProps) {
  const router = useRouter();
  const [base, setBase] = useState(ownBasePercentBp == null ? "" : String(ownBasePercentBp / 100));
  const [step, setStep] = useState(ownRatingStepBp == null ? "" : String(ownRatingStepBp / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // What the dealer earns now, with the values typed in (empty → the default).
  const baseBp = toBp(base) ?? defaults.basePercentBp;
  const stepBp = toBp(step) ?? defaults.ratingStepBp;
  const adjustmentBp = ratingOn ? Math.round((rating - 5) * stepBp) : 0;
  const effectiveBp = Math.max(0, baseBp + adjustmentBp);

  async function save() {
    const reason = window.prompt("Reason for this change (kept in the audit log):");
    if (!reason) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/dealer-commission", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "dealerRates", dealerId, commissionPercentBp: toBp(base), ratingStepBp: toBp(step), reason }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice("Saved. It applies to commission earned from now on.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="dealer-commission-rates">
      <h2 className="text-base font-bold text-ink-900">Commission for this dealer</h2>
      {model !== "BASE_PERCENT" ? (
        <Alert tone="info">The commission model is milestone rules, so these values are not used until it is switched to base %.</Alert>
      ) : null}
      {error ? <Alert tone="danger" title="Could not save">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Base commission (% of the fee)" hint={`Empty = the default, ${pct(defaults.basePercentBp)}.`}>
          <input className={inputClass} inputMode="decimal" value={base} placeholder={String(defaults.basePercentBp / 100)} onChange={(e) => setBase(e.target.value)} disabled={!isAdmin} />
        </Field>
        <Field label="Change per rating point (percentage points)" hint={`Empty = the default, ${pct(defaults.ratingStepBp)}.`}>
          <input className={inputClass} inputMode="decimal" value={step} placeholder={String(defaults.ratingStepBp / 100)} onChange={(e) => setStep(e.target.value)} disabled={!isAdmin} />
        </Field>
      </div>
      <p className="text-sm text-ink-700" data-testid="dealer-effective-rate">
        At rating {rating.toFixed(1)}: <strong>{pct(effectiveBp)}</strong> of the registration fee paid (base {pct(baseBp)}
        {ratingOn ? `, ${adjustmentBp < 0 ? "−" : "+"}${pct(Math.abs(adjustmentBp))} for the rating` : ", rating adjustment off"}).
      </p>
      {isAdmin ? (
        <Button disabled={busy} onClick={() => void save()}>
          Save commission
        </Button>
      ) : null}
    </Card>
  );
}
