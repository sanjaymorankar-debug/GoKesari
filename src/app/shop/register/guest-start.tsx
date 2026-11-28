"use client";

/**
 * 0231 (owner, 28-Nov-2026), /shop/register for a guest while onboarding_v2 is on: step 1 is the referral code
 * (pre-filled from ?ref= or the shared code; "I don't have one" when the admin setting does not require a code),
 * checked with the REFERRAL step's own rule; then the customer login sheet (Terms, e-mail code, mobile code) is the
 * identity step — customers and shop owners share it, one account. The sheet comes back to
 * /shop/register?ref=<code>&confirmed=1, where the code is saved and not asked again.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useLoginSheet } from "@/components/onboarding-v2/login-sheet";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

export function GuestShopStart({
  initialCode,
  referralRequired,
  linkCode = null,
  linkProblem = null,
}: {
  initialCode: string | null;
  referralRequired: boolean;
  /** Owner, 28-Nov-2026 (~11.45 IST): a valid code from a shared link — the referral step is not shown at all. */
  linkCode?: string | null;
  /** The shared link's code could not be used (invalid / expired): said plainly on step 1. */
  linkProblem?: string | null;
}) {
  const openSheet = useLoginSheet();
  const router = useRouter();
  const [code, setCode] = useState(initialCode ?? "");
  const [none, setNone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function next() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/shops/registration-draft/v2/guest-referral", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: none ? null : code.trim() || null }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setError(payload?.error?.details?.fields?.referralCode ?? payload?.error?.message ?? "Could not check the code. Please try again.");
      return;
    }
    const saved: string | null = payload?.code ?? null;
    openIdentity(saved ? `/shop/register?ref=${encodeURIComponent(saved)}&confirmed=1` : "/shop/register?confirmed=1");
  }

  function openIdentity(returnTo: string) {
    if (openSheet) openSheet({ returnTo, purpose: "shop" });
    else router.push(`/signin?callbackUrl=${encodeURIComponent(returnTo)}`);
  }

  if (linkCode) {
    // Straight to step 2: the code is saved once signed in (?ref=, checked again on the server).
    return (
      <Card className="rounded-2xl border-[var(--gk-line)] p-3 sm:p-5" data-testid="guest-shop-identity">
        <p className="text-xs font-semibold uppercase tracking-wide text-kesari-700">Step 2</p>
        <h2 className="text-base font-semibold text-ink-900 sm:text-lg">Your email and mobile</h2>
        <p className="mt-0.5 text-sm text-ink-500">
          Accept the Terms and confirm your email and mobile number — the same GoKesari account you shop with. Then the seller agreement.
        </p>
        <Button className="mt-3 w-full" onClick={() => openIdentity(`/shop/register?ref=${encodeURIComponent(linkCode)}`)} data-testid="guest-identity-continue">
          Continue
        </Button>
      </Card>
    );
  }

  return (
    <Card className="rounded-2xl border-[var(--gk-line)] p-3 sm:p-5" data-testid="guest-shop-start">
      <p className="text-xs font-semibold uppercase tracking-wide text-kesari-700">Step 1</p>
      <h2 className="text-base font-semibold text-ink-900 sm:text-lg">Your referral code</h2>
      <p className="mt-0.5 text-sm text-ink-500">
        The code of the GoKesari dealer, franchise or shop who told you about us. Next you accept the Terms and confirm your email and mobile number — the same GoKesari account you shop with.
      </p>
      <div className="mt-3 space-y-3">
        {linkProblem ? (
          <div data-testid="referral-link-problem">
            <Alert tone="warning">{linkProblem}</Alert>
          </div>
        ) : null}
        <Field label="Referral code" error={error ?? undefined}>
          <input
            className={inputClass}
            value={code}
            disabled={none}
            autoCapitalize="characters"
            maxLength={32}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. GKD-AB12CD"
            data-testid="guest-referral-code"
          />
        </Field>
        {!referralRequired ? (
          <label className="flex items-start gap-3 text-sm text-ink-700">
            <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={none} onChange={(e) => setNone(e.target.checked)} data-testid="guest-referral-none" />
            <span>I don&apos;t have a referral code</span>
          </label>
        ) : null}
        {referralRequired && !code.trim() ? <Alert tone="info">A referral code is needed to register a shop. Ask the dealer or shop who invited you.</Alert> : null}
        <Button className="w-full" disabled={busy || (!none && !code.trim())} onClick={() => void next()} data-testid="guest-referral-continue">
          {busy ? "Checking…" : "Continue"}
        </Button>
        <p className="text-center text-xs text-ink-500">
          Already have a GoKesari account? Continue — you sign in with the same email.
        </p>
      </div>
    </Card>
  );
}
