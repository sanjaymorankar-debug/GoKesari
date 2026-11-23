"use client";

/**
 * docs/guest-cart-2026-11: mounted for signed-in visitors while
 * guest_cart_enabled is on. If this browser still holds a guest cart (filled
 * before signing in), it is moved into the account cart once (POST
 * /api/cart/merge) and the page refreshes, so /cart — where "Place order" sent
 * the guest after sign-in — shows the items ready for checkout.
 *
 * The browser copy is taken (removed) before the call, so a second mount or a
 * second tab cannot add the same items twice; it is put back if the call fails.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { readGuestCart, writeGuestCart, clearGuestCart } from "@/lib/guest-cart";
import type { GuestCartMergeResult } from "@/server/services/guest-cart";

export function GuestCartMerge() {
  const router = useRouter();
  const [notice, setNotice] = useState<{ moved: number; problems: string[] } | null>(null);

  useEffect(() => {
    const cart = readGuestCart();
    if (cart.lines.length === 0) return;
    clearGuestCart();
    void (async () => {
      try {
        const response = await fetch("/api/cart/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lines: cart.lines }),
        });
        if (!response.ok) {
          // Signed out meanwhile, switched off, or a server error: keep the guest cart for later.
          writeGuestCart(cart);
          return;
        }
        const result = (await response.json()) as GuestCartMergeResult;
        const problems = [
          ...result.reduced.map((r) => `${r.productName ?? "An item"}: only ${r.quantity > 0 ? r.quantity : "what was already in your cart"} could be added (stock).`),
          ...result.dropped.map((d) => `${d.productName ?? "An item"}: not added — ${d.reason}`),
        ];
        // Shown even if the effect was re-run meanwhile (React dev runs it twice): the merge happened once.
        setNotice({ moved: result.added + result.reduced.filter((r) => r.quantity > 0).length, problems });
        router.refresh();
      } catch {
        writeGuestCart(cart);
      }
    })();
  }, [router]);

  if (!notice || (notice.moved === 0 && notice.problems.length === 0)) return null;
  return (
    <div
      role="status"
      data-testid="guest-cart-merged"
      className="fixed inset-x-3 bottom-20 z-50 mx-auto max-w-md rounded-2xl border border-kesari-200 bg-white p-4 text-sm shadow-lg sm:bottom-6"
    >
      <p className="font-bold text-ink-900">
        {notice.moved > 0 ? `${notice.moved} item${notice.moved === 1 ? "" : "s"} from before you signed in ${notice.moved === 1 ? "is" : "are"} in your cart.` : "Your cart was checked."}
      </p>
      {notice.problems.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-700">
          {notice.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex gap-3">
        <Link href="/cart" className="font-bold text-kesari-700 hover:underline" onClick={() => setNotice(null)}>
          Go to cart
        </Link>
        <button type="button" className="text-ink-600 hover:underline" onClick={() => setNotice(null)}>
          Close
        </button>
      </div>
    </div>
  );
}
