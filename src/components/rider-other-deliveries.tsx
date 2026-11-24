"use client";

/**
 * F3 — when a busy rider is offered a second delivery (busy-rider fallback),
 * it shows here under the main delivery card with its own Accept / Reject.
 * Empty (and not rendered) for a rider holding one delivery, as before.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6 (docs/hindi-marathi-2026-11/). */
const T = {
  errAction: L("Action failed.", "काम नहीं हो सका।", "कृती अयशस्वी झाली."),
  title: L("Also assigned to you", "आपको यह भी दिया गया है", "तुम्हाला हेही दिले आहे"),
  newOffer: L("New offer", "नया ऑफ़र", "नवीन ऑफर"),
  accept: L("Accept", "स्वीकारें", "स्वीकारा"),
  reject: L("Reject", "मना करें", "नाकारा"),
  finishFirst: L(
    "Finish your current delivery first; this one becomes your main card next.",
    "पहले मौजूदा डिलीवरी पूरी करें; उसके बाद यह आपका मुख्य कार्ड बनेगा।",
    "आधी सध्याची डिलिव्हरी पूर्ण करा; त्यानंतर हे तुमचे मुख्य कार्ड होईल.",
  ),
} as const;

export interface OtherDelivery {
  id: string;
  status: string;
  orderNumber: string;
  shopName: string;
  distanceKm: string | null;
}

export function RiderOtherDeliveries({ deliveries, lang = "en" }: { deliveries: OtherDelivery[]; lang?: Lang }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (deliveries.length === 0) return null;

  async function act(id: string, action: "accept" | "reject") {
    setBusy(id);
    setError(null);
    const res = await fetch(`/api/delivery-orders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action === "reject" ? { action, reason: "Busy with another delivery" } : { action }),
    });
    setBusy(null);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return setError(errorText(body?.error?.message ?? tr(T.errAction, lang), lang, body?.error?.code));
    }
    router.refresh();
  }

  return (
    <Card className="mt-4 space-y-3 p-4" data-testid="rider-other-deliveries">
      <p className="font-semibold text-ink-900">{tr(T.title, lang)}</p>
      {deliveries.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-cream-200 pt-2 text-sm">
          <span>
            <Badge tone={d.status === "OFFERED" ? "warning" : "info"}>{d.status === "OFFERED" ? tr(T.newOffer, lang) : d.status.toLowerCase().replace("_", " ")}</Badge>{" "}
            <strong>{d.orderNumber}</strong> · {d.shopName}
            {d.distanceKm ? ` · ~${Number(d.distanceKm).toFixed(1)} km` : ""}
          </span>
          {d.status === "OFFERED" ? (
            <span className="flex gap-2">
              <Button size="sm" disabled={busy === d.id} onClick={() => act(d.id, "accept")}>{tr(T.accept, lang)}</Button>
              <Button size="sm" variant="secondary" disabled={busy === d.id} onClick={() => act(d.id, "reject")}>{tr(T.reject, lang)}</Button>
            </span>
          ) : (
            <span className="text-xs text-ink-500">{tr(T.finishFirst, lang)}</span>
          )}
        </div>
      ))}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}
