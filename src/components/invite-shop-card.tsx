"use client";

import { useState } from "react";

/**
 * "More shops are joining" — fills the row beside a short shop list and lets
 * a customer send a shop owner the sign-up link. Uses the device's share
 * sheet where there is one (phones), and copies the link otherwise. Nothing
 * is stored: it is the customer's own message to someone they know.
 */
export function InviteShopCard({ area }: { area: string | null }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function invite() {
    const url = `${window.location.origin}/shop/register`;
    const text = "I'd like to order from your shop on GoKesari. You can list it here:";
    try {
      if (navigator.share) {
        await navigator.share({ title: "List your shop on GoKesari", text, url });
        return;
      }
      await navigator.clipboard.writeText(`${text} ${url}`);
      setStatus("copied");
    } catch (error) {
      // Closing the share sheet is not a failure.
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("failed");
    }
  }

  return (
    <div className="flex h-full min-h-40 flex-col justify-center rounded-xl border border-dashed border-kesari-300 bg-cream-50 p-4" data-testid="invite-shop-card">
      <h3 className="text-base font-semibold text-ink-900">
        More {area ? `${area} ` : ""}shops are joining
      </h3>
      <p className="mt-1 text-sm text-ink-600">Know a shop you&apos;d like to order from? Send them an invite.</p>
      <div className="mt-3">
        <button
          type="button"
          onClick={invite}
          className="tap-target rounded-lg border border-kesari-300 bg-white px-3 py-1.5 text-sm font-medium text-kesari-700 hover:bg-kesari-50"
        >
          Invite a shop
        </button>
      </div>
      <p className="mt-2 min-h-4 text-xs text-ink-600" role="status">
        {status === "copied"
          ? "Invite link copied. Paste it in a message to the shop."
          : status === "failed"
            ? "Could not share from this browser. The sign-up page is gokesari.com/shop/register."
            : ""}
      </p>
    </div>
  );
}
