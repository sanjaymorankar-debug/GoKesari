"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, inputClass } from "@/components/ui";
import { formatPaiseCompact, rupeesToPaise } from "@/lib/money";
import {
  MAX_TURNOVER_SLABS,
  turnoverSlabLabel,
  turnoverSlabsProblem,
  type TurnoverFeeRule,
  type TurnoverFeeSlab,
} from "@/lib/registration-fee";

const CRORE = 1_00_00_000;

interface DraftSlab {
  /** Upper turnover limit in ₹ crore, as typed; ignored on the last slab. */
  limit: string;
  /** Fee in ₹ before GST, as typed. */
  fee: string;
}

/**
 * The registration fee by turnover slab (owner, 28 Oct 2026): any number of
 * slabs (up to 20) — each with its upper turnover limit in crore, except the
 * last, which covers everything above — and the fee for each, before GST. The
 * admin adds a slab (it goes in before the last, "above" slab) or removes one.
 * Saved as the admin rule `registrationFeeByTurnover`; ADMIN only, audited.
 * Shops already registered keep the fee they were charged.
 */
export function RegistrationFeeSlabsEditor({ rule, gstLabel }: { rule: TurnoverFeeRule; gstLabel: string | null }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(rule.enabled);
  const [slabs, setSlabs] = useState<DraftSlab[]>(
    rule.slabs.map((s) => ({ limit: s.upToRupees === null ? "" : String(s.upToRupees / CRORE), fee: String(s.feePaise / 100) })),
  );
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

  const last = slabs.length - 1;
  const parsed: (TurnoverFeeSlab | null)[] = slabs.map((s, i) => {
    const feePaise = rupees(s.fee);
    const upToRupees = i === last ? null : crore(s.limit);
    if (feePaise === null || (i !== last && upToRupees === null)) return null;
    return { upToRupees, feePaise };
  });
  const complete = parsed.every((s) => s !== null) ? (parsed as TurnoverFeeSlab[]) : null;
  const problem = complete ? turnoverSlabsProblem(complete) : null;
  const preview: TurnoverFeeRule | null = complete && !problem ? { enabled, slabs: complete } : null;

  function update(i: number, patch: Partial<DraftSlab>) {
    setSlabs((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  /** A new slab goes in just before the last ("above") slab, with a limit above the one before it. */
  function addSlab() {
    setSlabs((all) => {
      const beforeLast = all.length >= 2 ? crore(all[all.length - 2].limit) : null;
      const suggested = beforeLast === null ? "" : String((beforeLast * 2) / CRORE);
      const added = { limit: suggested, fee: all[all.length - 1]?.fee ?? "" };
      return [...all.slice(0, -1), added, all[all.length - 1]];
    });
  }

  function removeSlab(i: number) {
    setSlabs((all) => {
      const next = all.filter((_, j) => j !== i);
      // Removing the last slab makes the one before it the "above" slab.
      return next.map((s, j) => (j === next.length - 1 ? { ...s, limit: "" } : s));
    });
  }

  async function save(): Promise<void> {
    if (!complete) {
      setError("Enter a turnover limit in crore for every slab but the last, and a fee in rupees (0 or more) for every slab.");
      return;
    }
    if (problem || !preview) {
      setError(problem ?? "Check the slabs.");
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

      <ol className="space-y-3" data-testid="fee-slab-rows">
        {slabs.map((slab, i) => (
          <li key={i} className="rounded-xl border border-[var(--gk-line)] p-3" data-testid={`fee-slab-${i + 1}`}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-ink-900">
                Slab {i + 1}
                {preview ? <span className="ml-2 font-normal text-ink-500">{turnoverSlabLabel(i + 1, preview)}</span> : null}
              </span>
              {slabs.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removeSlab(i)}
                  className="min-h-11 rounded-lg px-3 text-sm font-semibold text-red-700 hover:bg-red-50"
                  aria-label={`Remove slab ${i + 1}`}
                >
                  Remove
                </button>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {i === last ? (
                <p className="self-end text-xs text-ink-500">
                  {slabs.length === 1 ? "Every turnover." : "Every turnover above the slab before."}
                </p>
              ) : (
                <label className="block">
                  <span className="text-xs text-ink-500">Turnover up to (₹ crore)</span>
                  <input
                    value={slab.limit}
                    onChange={(e) => update(i, { limit: e.target.value })}
                    inputMode="decimal"
                    className={inputClass}
                    aria-label={`Slab ${i + 1} turnover limit`}
                  />
                </label>
              )}
              <label className="block">
                <span className="text-xs text-ink-500">Fee (₹, before GST)</span>
                <input
                  value={slab.fee}
                  onChange={(e) => update(i, { fee: e.target.value })}
                  inputMode="decimal"
                  className={inputClass}
                  aria-label={`Slab ${i + 1} fee`}
                />
              </label>
            </div>
          </li>
        ))}
      </ol>

      {slabs.length < MAX_TURNOVER_SLABS ? (
        <Button variant="secondary" onClick={addSlab} data-testid="fee-slab-add">
          Add slab
        </Button>
      ) : (
        <p className="text-xs text-ink-500">{MAX_TURNOVER_SLABS} slabs is the most.</p>
      )}

      {problem ? <p className="text-sm text-red-700">{problem}</p> : null}
      {preview ? (
        <p className="text-xs text-ink-500">
          {preview.slabs.map((s, i) => `${turnoverSlabLabel(i + 1, preview)}: ${formatPaiseCompact(s.feePaise)}`).join(" · ")}
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
