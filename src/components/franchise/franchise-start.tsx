"use client";
/**
 * Onboarding v2 — Become a franchisee (docs/onboarding-v2-2026-11). Choose the model (mandatory): free dealer (no
 * area; live at once with a GKD code) or paid franchise (zones + subscription plan + optional coupon, pay online,
 * live at payment). The paid path reuses the zone booking (list / map / cart / coupon / pay) in its v2 mode.
 */
import Link from "next/link";
import { useState, type ComponentProps } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";
import type { StartState } from "@/server/onboarding-v2/franchise";
import { ZoneBooking, type PlanOption } from "./zone-booking";

type BookingProps = Omit<ComponentProps<typeof ZoneBooking>, "signedIn" | "v2" | "initialJoin"> & { plans: PlanOption[] };

const pct = (bp: number) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;

export function FranchiseStart({ state, initialModel, booking }: { state: StartState; initialModel: "free" | "paid" | null; booking: BookingProps }) {
  const [model, setModel] = useState<"free" | "paid" | null>(state.isFranchisee ? null : initialModel === "free" && state.isFreeDealer ? null : initialModel);
  const [step, setStep] = useState<"choose" | "zones">("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freeCode, setFreeCode] = useState<string | null>(state.isFreeDealer || state.isFranchisee ? state.dealer?.code ?? null : null);
  const { plans, ...zoneProps } = booking;
  const rates = booking.rates;

  async function start(which: "free" | "paid") {
    setModel(which);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/franchise/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: which }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const to = payload?.error?.details?.redirect as string | undefined;
        if (to) {
          window.location.href = to;
          return;
        }
        throw new Error(payload?.error?.message ?? "Something went wrong. Please try again.");
      }
      if (which === "free") setFreeCode(payload?.code ?? null);
      else setStep("zones");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (step === "zones") {
    return (
      <div className="space-y-3" data-testid="franchise-start-zones">
        <Button variant="secondary" size="sm" onClick={() => setStep("choose")}>
          ← Change model
        </Button>
        <ZoneBooking {...zoneProps} signedIn v2={{ plans, payoutMissing: state.payoutMissing }} />
      </div>
    );
  }

  const live = state.isFreeDealer || state.isFranchisee || !!freeCode;
  return (
    <div className="space-y-4" data-testid="franchise-start">
      {live ? (
        <Card className="space-y-2 p-4" data-testid="franchise-start-live">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success">{state.isFranchisee ? "Franchisee" : "Dealer"} · live</Badge>
            {freeCode ? (
              <span className="text-sm text-ink-700">
                Your dealer code: <strong data-testid="franchise-start-code">{freeCode}</strong>
              </span>
            ) : null}
          </div>
          <p className="text-sm text-ink-700">Share your code with shops, or register shops from your dealer page. Build your team under &quot;My team&quot;.</p>
          {state.payoutMissing.length ? <Alert tone="info">Before your first payout, add your {state.payoutMissing.join(" and ")} on your dealer page. Going live does not wait for them.</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Link className="inline-flex min-h-10 items-center rounded-lg bg-kesari-600 px-4 text-sm font-semibold text-white" href="/dealer">
              Dealer page
            </Link>
            <Link className="inline-flex min-h-10 items-center rounded-lg border border-kesari-600 px-4 text-sm font-semibold text-kesari-800" href="/dealer/team" data-testid="franchise-start-team">
              My team
            </Link>
            {state.isFranchisee ? (
              <Link className="inline-flex min-h-10 items-center rounded-lg border border-kesari-600 px-4 text-sm font-semibold text-kesari-800" href="/franchise/my">
                My franchise
              </Link>
            ) : null}
          </div>
        </Card>
      ) : null}

      <h2 className="text-lg font-bold text-ink-900">{live ? "Own a zone too?" : "Choose how you want to work"}</h2>
      <div className="grid gap-3 md:grid-cols-2">
        {!live ? (
          <Card className={`flex flex-col gap-3 p-4 ${model === "free" ? "ring-2 ring-kesari-500" : ""}`} data-testid="model-free">
            <div>
              <Badge tone="success">No fee</Badge>
              <h3 className="mt-2 text-lg font-bold text-ink-900">Free dealer</h3>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
              <li>No zone to choose — work anywhere.</li>
              <li>Your dealer code (GKD-…) at once; you are live straight away.</li>
              <li>
                One-time commission on each shop&apos;s registration fee: <strong>{pct(rates.freeSelfBp)}</strong> on shops you register, <strong>{pct(rates.freeOverrideBp)}</strong> and <strong>{pct(rates.freeSecondBp)}</strong> on your team&apos;s shops.
              </li>
              <li>PAN and payout bank account only before your first payout.</li>
            </ul>
            <Button className="mt-auto" onClick={() => void start("free")} disabled={busy} data-testid="model-free-go">
              {busy && model === "free" ? "Please wait…" : "Become a free dealer"}
            </Button>
          </Card>
        ) : null}
        <Card className={`flex flex-col gap-3 p-4 ${model === "paid" ? "ring-2 ring-kesari-500" : ""}`} data-testid="model-paid">
          <div>
            <Badge tone="info">Subscription</Badge>
            <h3 className="mt-2 text-lg font-bold text-ink-900">Paid franchise</h3>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
            <li>Choose your zone(s) — at most {booking.offer.maxOwnersPerZone} franchises a zone, availability shown — and a subscription plan.</li>
            <li>
              One-time: <strong>{pct(rates.ownerSelfBp)}</strong> on shops you register; <strong>{pct(rates.ownerOverrideBp)}</strong> / <strong>{pct(rates.ownerSecondBp)}</strong> on your team&apos;s shops. Every month: <strong>{pct(rates.recurringBp)}</strong> of GoKesari&apos;s commission on your zone&apos;s orders.
            </li>
            <li>Pay 100% online (coupon optional); live with your franchise code (GKF-…) as soon as the payment succeeds.</li>
          </ul>
          {plans.length ? (
            <ul className="space-y-1 text-sm text-ink-800" data-testid="model-paid-plans">
              {plans.map((p) => (
                <li key={p.id}>
                  <strong>{p.name}</strong> — {p.label}
                </li>
              ))}
            </ul>
          ) : (
            <Alert tone="warning">No subscription plan is on offer right now.</Alert>
          )}
          <Button
            className="mt-auto"
            onClick={() => void start("paid")}
            disabled={busy || !plans.length || !booking.offer.bookingOpen}
            data-testid="model-paid-go"
          >
            {busy && model === "paid" ? "Please wait…" : "Choose zones and plan"}
          </Button>
          {!booking.offer.bookingOpen ? <p className="text-xs text-ink-500">{booking.offer.closedMessage ?? "Bookings are not open yet."}</p> : null}
        </Card>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
