"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, inputClass } from "@/components/ui";
import { formatPaiseCompact, rupeesToPaise } from "@/lib/money";
import { turnoverSlabLabel, type TurnoverFeeRule } from "@/lib/registration-fee";

const CRORE = 1_00_00_000;

/**
 * The registration fee by turnover slab (owner, 28 Oct 2026): the two turnover
 * limits (in crore) and the fee for each of the three slabs, before GST. Saved
 * as the admin rule `registrationFeeByTurnover`; ADMIN only, audited. Shops
 * already registered keep the fee they were charged.
 */
export function RegistrationFeeSlabsEditor({ rule, gstLabel }: { rule: TurnoverFeeRule; gstLabel: string | null }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(rule.enabled);
  const [limit1, setLimit1] = useState(String(rule.slab1UpToRupees / CRORE));
  const [limit2, setLimit2] = useState(String(rule.slab2UpToRupees / CRORE));
  const [fees, setFees] = useState([rule.slab1FeePaise, rule.slab2FeePaise, rule.slab3FeePaise].map((p) => String(p / 100)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const crore = (raw: string) => {
    const n = Number(raw.replace(/[,\s]/g, ""));
    return raw.trim() !== "" && Number.isFinite(n) && n > 0 ? Math.round(n * CRORE) : null;
  };
  const rupees = (raw: string) => {
    const n = Number(raw.replace(/[₹,\s]/g, ""));
    return raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? rupeesToPaise(n) : null;
  };

  const slab1UpToRupees = crore(limit1);
  const slab2UpToRupees = crore(limit2);
  const feePaise = fees.map(rupees);
  const preview: TurnoverFeeRule | null =
    slab1UpToRupees !== null && slab2UpToRupees !== null && slab2UpToRupees > slab1UpToRupees && feePaise.every((p) => p !== null)
      ? {
          enabled,
          slab1UpToRupees,
          slab2UpToRupees,
          slab1FeePaise: feePaise[0]!,
          slab2FeePaise: feePaise[1]!,
          slab3FeePaise: feePaise[2]!,
        }
      : null;

  async function save(): Promise<void> {
    if (slab1UpToRupees === null || slab2UpToRupees === null) {
      setError("Enter both turnover limits in crore, e.g. 2 and 10.");
      return;
    }
    if (slab2UpToRupees <= slab1UpToRupees) {
      setError("Slab 2's limit must be above slab 1's.");
      return;
    }
    if (!preview) {
      setError("Enter a fee in rupees for every slab (0 or more).");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "registrationFeeByTurnover", value: preview }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice("Fee slabs saved. Shops registering from now on pay these fees; registered shops are unaffected.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const setFee = (i: number, value: string) => setFees((all) => all.map((f, j) => (j === i ? value : f)));

  return (
    <Card className="space-y-4 p-4" data-testid="fee-slabs-editor">
      {error ? <Alert tone="danger" title="Could not save">{error}</Alert> : null}
      {notice ? <Alert tone="success" title="Saved">{notice}</Alert> : null}

      <label className="flex items-center gap-2 text-sm text-ink-800">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Charge the registration fee by annual turnover
      </label>
      <p className="text-xs text-ink-500">
        Off: every shop pays the flat fee below. On: the owner enters their annual turnover on Add my
        shop and pays the fee for its slab.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-ink-500">Slab 1: turnover up to (₹ crore)</span>
          <input value={limit1} onChange={(e) => setLimit1(e.target.value)} inputMode="decimal" className={inputClass} />
        </label>
        <label className="block">
          <span className="text-xs text-ink-500">Slab 2: turnover up to (₹ crore)</span>
          <input value={limit2} onChange={(e) => setLimit2(e.target.value)} inputMode="decimal" className={inputClass} />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <label key={i} className="block">
            <span className="text-xs text-ink-500">
              Slab {i + 1} fee (₹, before GST)
              {preview ? <span className="block text-ink-400">{turnoverSlabLabel((i + 1) as 1 | 2 | 3, preview)}</span> : null}
            </span>
            <input
              value={fees[i]}
              onChange={(e) => setFee(i, e.target.value)}
              inputMode="decimal"
              className={inputClass}
              aria-label={`Slab ${i + 1} fee`}
            />
          </label>
        ))}
      </div>

      {preview ? (
        <p className="text-xs text-ink-500">
          {[1, 2, 3]
            .map((s) => `${turnoverSlabLabel(s as 1 | 2 | 3, preview)}: ${formatPaiseCompact(feePaise[s - 1]!)}`)
            .join(" · ")}
          {gstLabel ? ` — plus GST at ${gstLabel}.` : " — plus GST."}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button disabled={busy} onClick={save}>
          Save fee slabs
        </Button>
        <p className="text-xs text-ink-500">Applies to registrations from now on. Every change is audited.</p>
      </div>
    </Card>
  );
}
