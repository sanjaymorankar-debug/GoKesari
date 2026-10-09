"use client";

/**
 * Module 3: the applicant's private page. Pay the fee (Cashfree checkout;
 * a test button in mock mode), then wait for the gateway's confirmation —
 * the page checks every few seconds; only the webhook approves the shop.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";
import { openCashfreeCheckout } from "@/lib/cashfree-checkout";

export interface JoinStatus {
  status: "PENDING_PAYMENT" | "APPROVED" | "EXPIRED" | "CANCELLED";
  shopName: string;
  mobile: string;
  feePaise: number;
  tier: { code: string; label: string } | null;
  referralCode: string | null;
  lastPayment: { status: string; failureReason: string | null } | null;
  shop: { id: string; registrationNumber: string; name: string } | null;
  receipt: string | null;
  gateway: "CASHFREE" | "MOCK";
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function JoinStatusView({ token, initial, returnedFromGateway }: { token: string; initial: JoinStatus; returnedFromGateway: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(returnedFromGateway && initial.status === "PENDING_PAYMENT");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!waiting) return;
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      const res = await fetch(`/api/shop-registrations/${token}`);
      if (res.ok) {
        const next = (await res.json()) as JoinStatus;
        setStatus(next);
        if (next.status !== "PENDING_PAYMENT" || next.lastPayment?.status === "FAILED" || next.lastPayment?.status === "MISMATCH") setWaiting(false);
      }
      if (tries > 30) setWaiting(false);
    }, 3000);
    return () => clearInterval(timer);
  }, [waiting, token]);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/shop-registrations/${token}/pay`, { method: "POST" });
      const intent = await res.json().catch(() => null);
      if (!res.ok) throw new Error(intent?.error?.message ?? "Could not start the payment.");
      if (intent.gateway === "CASHFREE") {
        await openCashfreeCheckout({ paymentSessionId: intent.paymentSessionId }, intent.cashfreeMode);
      } else {
        // Test mode (no gateway keys): settle through the same webhook code path.
        const settled = await fetch("/api/dev/settle-registration", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!settled.ok) throw new Error("The test payment could not be completed.");
      }
      setWaiting(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  if (status.status === "APPROVED" && status.shop) {
    return (
      <Card className="space-y-3 p-4">
        <Badge tone="success">Approved</Badge>
        <h2 className="text-lg font-semibold text-ink-900">{status.shop.name} is live on GoKesari</h2>
        <p className="text-sm text-ink-700">
          Shop number <b>{status.shop.registrationNumber}</b>. Sign in with your mobile {status.mobile} (we send the code by SMS), then complete your profile: address, shop type and product categories.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href="/signin?callbackUrl=/shop/profile-setup" className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white">Sign in and complete profile</Link>
          {status.receipt ? (
            <a href={`/api/shop-registrations/${token}/receipt`} className="rounded-lg border border-cream-200 px-4 py-2 text-sm font-medium text-ink-700">Receipt {status.receipt}</a>
          ) : null}
        </div>
      </Card>
    );
  }

  if (status.status === "CANCELLED" || status.status === "EXPIRED") {
    return <Alert tone="warning" title="This registration is closed">Start a new registration, or ask your distributor for help.</Alert>;
  }

  return (
    <Card className="space-y-3 p-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div><dt className="text-xs text-ink-500">Shop</dt><dd className="font-medium">{status.shopName}</dd></div>
        <div><dt className="text-xs text-ink-500">Mobile</dt><dd>{status.mobile}</dd></div>
        <div><dt className="text-xs text-ink-500">Plan</dt><dd>{status.tier?.label}</dd></div>
        <div><dt className="text-xs text-ink-500">Referral code</dt><dd>{status.referralCode}</dd></div>
      </dl>
      {status.lastPayment?.status === "FAILED" ? <Alert tone="warning">The last payment did not go through ({status.lastPayment.failureReason}). You can try again.</Alert> : null}
      {status.lastPayment?.status === "MISMATCH" ? <Alert tone="danger">The last payment did not match the fee. GoKesari support has been told and will contact you.</Alert> : null}
      {waiting ? (
        <Alert tone="info">Waiting for the payment confirmation from the bank… this page updates by itself.</Alert>
      ) : (
        <Button className="w-full" disabled={busy} onClick={() => void pay()}>
          {busy ? "Opening payment…" : `Pay ${rupees(status.feePaise)}`}{status.gateway === "MOCK" ? " (test payment)" : ""}
        </Button>
      )}
      <p className="text-xs text-ink-500">Your shop is approved as soon as the payment is confirmed by the payment gateway. Keep this link — it was also sent to you by SMS.</p>
    </Card>
  );
}
