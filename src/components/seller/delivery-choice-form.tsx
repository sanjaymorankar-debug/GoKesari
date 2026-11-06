"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button } from "@/components/ui";
import { tr, UI, type Lang } from "@/lib/board/i18n";
import { SHOP_DELIVERY_CHOICES, type ShopDeliveryChoice } from "@/lib/shop-delivery-choice";

const TEXT: Record<ShopDeliveryChoice, { label: keyof typeof UI; hint: keyof typeof UI; icon: string }> = {
  OWN_STAFF: { label: "deliveryOwnStaff", hint: "deliveryOwnStaffHint", icon: "🛵" },
  GOKESARI_PARTNER: { label: "deliveryPartner", hint: "deliveryPartnerHint", icon: "🚚" },
  PICKUP_ONLY: { label: "deliveryPickup", hint: "deliveryPickupHint", icon: "🏪" },
};

/**
 * "How you deliver" (onboarding Phase 2, WP3): three tiles and, when the shop delivers, its radius —
 * one screen, one save, through the shop's own settings API.
 */
export function DeliveryChoiceForm({
  lang,
  shopId,
  choice,
  radiusKm,
}: {
  lang: Lang;
  shopId: string;
  choice: ShopDeliveryChoice | null;
  radiusKm: number;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<ShopDeliveryChoice | null>(choice);
  const [radius, setRadius] = useState(Math.min(Math.max(radiusKm, 1), 10));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save() {
    if (!picked) return;
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/shops/${shopId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(picked === "PICKUP_ONLY" ? { deliveryChoice: picked } : { deliveryChoice: picked, serviceRadiusKm: radius }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setBusy(false);
    if (response?.ok) {
      setMessage({ tone: "success", text: tr(UI.deliverySaved, lang) });
      router.refresh();
    } else {
      setMessage({ tone: "danger", text: payload?.error?.message ?? tr(UI.deliveryError, lang) });
    }
  }

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="sr-only">{tr(UI.deliveryTitle, lang)}</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {SHOP_DELIVERY_CHOICES.map((key) => {
            const on = picked === key;
            return (
              <label
                key={key}
                className={`flex min-h-24 cursor-pointer flex-col gap-1 rounded-2xl border p-3 text-sm ${
                  on ? "border-kesari-600 bg-kesari-50 ring-2 ring-kesari-600" : "border-[var(--gk-line)] bg-white"
                }`}
                data-testid={`delivery-choice-${key}`}
              >
                <span className="flex items-center gap-2 font-semibold text-ink-900">
                  <input type="radio" name="delivery-choice" value={key} checked={on} onChange={() => setPicked(key)} className="h-5 w-5" />
                  <span aria-hidden>{TEXT[key].icon}</span>
                  {tr(UI[TEXT[key].label], lang)}
                </span>
                <span className="text-ink-600">{tr(UI[TEXT[key].hint], lang)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {picked && picked !== "PICKUP_ONLY" ? (
        <label className="block text-sm text-ink-700">
          <span className="font-medium">
            {tr(UI.deliveryRadius, lang)}: <strong>{radius} km</strong>
          </span>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            className="mt-2 block w-full"
            data-testid="delivery-radius"
          />
        </label>
      ) : null}

      {message ? (
        <div role={message.tone === "danger" ? "alert" : "status"}>
          <Alert tone={message.tone}>{message.text}</Alert>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={!picked || busy} data-testid="delivery-save">
          {tr(UI.deliverySave, lang)}
        </Button>
        {picked === "OWN_STAFF" ? (
          <Link href="/shop/delivery-staff" className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 px-4 text-sm font-medium text-ink-700">
            {tr(UI.deliveryAddStaff, lang)}
          </Link>
        ) : null}
        <Link href="/shop/setup" className="inline-flex min-h-11 items-center rounded-lg px-4 text-sm text-ink-600 underline">
          {tr(UI.deliveryBack, lang)}
        </Link>
      </div>
    </div>
  );
}
