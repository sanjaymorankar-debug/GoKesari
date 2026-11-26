"use client";

/**
 * docs/onboarding-v2-2026-11 (flag onboarding_v2): /wa/cart for a guest — the WhatsApp link's lines go into the
 * browser cart and the guest continues on /cart (sign-in only at "Place order"). The link itself is not used up
 * here: it is single-use only for a signed-in claim, as before.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button } from "@/components/ui";
import { addToGuestCart, guestCartRefusal } from "@/lib/guest-cart";

export function WaCartGuestAdd({ lines, label }: { lines: { shopProductId: string; quantity: number }[]; label: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button
        size="lg"
        className="w-full"
        data-testid="wa-cart-guest-add"
        onClick={() => {
          for (const line of lines) {
            const change = addToGuestCart(line.shopProductId, line.quantity);
            if (!change.ok) {
              setError(guestCartRefusal(change.reason));
              return;
            }
          }
          router.push("/cart?from=whatsapp");
        }}
      >
        {label}
      </Button>
    </div>
  );
}
