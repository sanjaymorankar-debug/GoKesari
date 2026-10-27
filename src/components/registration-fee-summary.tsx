"use client";

/**
 * Add my shop: the one-time registration fee before Submit (owner, 27 Oct
 * 2026) — the base fee, a coupon the owner may apply, GST on the rest, and the
 * total. The coupon is checked by the server (GET /api/shops/registration-fee-quote);
 * the fee actually charged is computed again when the shop is saved.
 */
import { useState, type KeyboardEvent } from "react";

import { Button, inputClass } from "@/components/ui";
import { formatPaiseCompact } from "@/lib/money";
import { formatGstRate, registrationFeeBreakdown } from "@/lib/registration-fee";

export interface AppliedCoupon {
  code: string;
  discountPaise: number;
  description: string | null;
}

export function RegistrationFeeSummary({
  basePaise,
  gstRateBp,
  turnoverRupees = null,
  coupon,
  onCoupon,
  serverError,
}: {
  basePaise: number;
  gstRateBp: number;
  /** Sent with the coupon while the fee is set by turnover. */
  turnoverRupees?: number | null;
  coupon: AppliedCoupon | null;
  onCoupon: (coupon: AppliedCoupon | null) => void;
  /** The server's refusal of the coupon on Submit, if any. */
  serverError?: string;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fee = registrationFeeBreakdown(basePaise, coupon?.discountPaise ?? 0, gstRateBp);

  async function apply() {
    const entered = code.trim();
    if (!entered) {
      setError("Enter a coupon code.");
      return;
    }
    setBusy(true);
    setError(null);
    const query = new URLSearchParams({ coupon: entered });
    if (turnoverRupees !== null) query.set("turnover", String(turnoverRupees));
    try {
      const res = await fetch(`/api/shops/registration-fee-quote?${query}`);
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error?.details?.fields?.couponCode ?? payload?.error?.message ?? "That coupon could not be applied.");
        return;
      }
      onCoupon({ code: payload.couponCode, discountPaise: payload.discountPaise, description: payload.couponDescription ?? null });
      setCode("");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter applies the coupon instead of submitting the whole form.
    if (event.key === "Enter") {
      event.preventDefault();
      void apply();
    }
  }

  const shownError = error ?? (coupon ? undefined : serverError);

  return (
    <div className="rounded-lg border border-kesari-100 bg-kesari-50 p-4 sm:col-span-2" data-testid="registration-fee-summary">
      <p className="text-sm font-semibold text-ink-900">One-time registration fee</p>
      <dl className="mt-2 space-y-1 text-sm text-ink-700" aria-live="polite">
        <div className="flex justify-between gap-4">
          <dt>Registration fee</dt>
          <dd>{formatPaiseCompact(fee.basePaise)}</dd>
        </div>
        {coupon ? (
          <div className="flex justify-between gap-4 text-green-700">
            <dt>Coupon {coupon.code}</dt>
            <dd>− {formatPaiseCompact(fee.discountPaise)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-4">
          <dt>GST ({formatGstRate(fee.gstRateBp)})</dt>
          <dd>{formatPaiseCompact(fee.gstPaise)}</dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-kesari-100 pt-1 font-semibold text-ink-900">
          <dt>Total payable</dt>
          <dd data-testid="registration-fee-preview">{formatPaiseCompact(fee.totalPaise)}</dd>
        </div>
      </dl>

      {coupon ? (
        <p className="mt-3 text-xs text-ink-500">
          {coupon.description ? `${coupon.description} · ` : null}
          <button type="button" className="underline" onClick={() => onCoupon(null)}>
            Remove coupon
          </button>
        </p>
      ) : (
        <div className="mt-3">
          <label htmlFor="registration-coupon" className="text-xs text-ink-500">
            Have a coupon code?
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="registration-coupon"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={onKeyDown}
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={32}
              className={inputClass}
              aria-invalid={shownError ? true : undefined}
            />
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void apply()}>
              {busy ? "Applying…" : "Apply"}
            </Button>
          </div>
          {shownError ? <p className="mt-1 text-xs text-red-700">{shownError}</p> : null}
        </div>
      )}
      <p className="mt-2 text-xs text-ink-500">You pay it online on the next screen, after you submit.</p>
    </div>
  );
}
