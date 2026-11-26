"use client";

/**
 * Blocking screen after sign-in (docs/seller-agreements-2026-11, brief §3): an existing shop whose owner has
 * not signed the current agreements (or must re-confirm Annexure A) sees this instead of Seller Central.
 * During the grace period the owner may postpone for the day; once it has passed there is no way round it
 * (and the shop takes no new orders) until they sign. My Agreements and the licence upload page stay open.
 */
import { useRouter } from "next/navigation";

import { Alert, Button, Card, LinkButton } from "@/components/ui";
import { AGREEMENTS_LATER_COOKIE } from "@/lib/seller-agreements";

const istFmt = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " IST";

export function AgreementsGate({ shopId, shopName, graceUntil, overdue, reasonText }: { shopId: string; shopName: string; graceUntil: string | null; overdue: boolean; reasonText: string }) {
  const router = useRouter();
  function later() {
    // Until the end of today (IST) for this shop.
    const now = new Date();
    const istMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (now.getUTCHours() * 60 + now.getUTCMinutes() >= 18 * 60 + 30 ? 2 : 1)) - 330 * 60_000);
    document.cookie = `${AGREEMENTS_LATER_COOKIE}=${shopId}; path=/shop; expires=${istMidnight.toUTCString()}; samesite=lax`;
    router.refresh();
  }
  return (
    <main className="min-h-screen bg-cream-50 px-4 py-6" data-testid="agreements-gate">
      <Card className="mx-auto max-w-xl space-y-4">
        <h1 className="text-xl font-semibold text-ink-900">Sign your shop agreements – {shopName}</h1>
        <p className="text-sm text-ink-700">{reasonText}</p>
        <p className="text-sm text-ink-700" lang="mr">आपल्या दुकानासाठी तयार केलेले करार वाचा आणि OTP द्वारे स्वाक्षरी करा.</p>
        <p className="text-sm text-ink-700" lang="hi">अपनी दुकान के लिए तैयार अनुबंध पढ़ें और OTP से हस्ताक्षर करें।</p>
        {graceUntil ? (
          <Alert tone={overdue ? "danger" : "warning"}>
            {overdue ? (
              <>The grace period ended on <strong>{istFmt(graceUntil)}</strong>. {shopName} can&apos;t accept new orders until you sign.</>
            ) : (
              <>Please sign by <strong>{istFmt(graceUntil)}</strong>. After that {shopName} can&apos;t accept new orders until you sign.</>
            )}
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <LinkButton href={`/shop/agreements?shop=${shopId}`}>Review and sign</LinkButton>
          {!overdue ? (
            <Button variant="secondary" onClick={later} data-testid="agreements-later">
              Remind me later
            </Button>
          ) : null}
        </div>
      </Card>
    </main>
  );
}
