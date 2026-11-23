"use client";

import { useState } from "react";
import clsx from "clsx";

import { Alert } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";

const T = {
  label: L("Order updates on WhatsApp", "WhatsApp पर ऑर्डर अपडेट", "WhatsApp वर ऑर्डर अपडेट"),
  hint: L(
    "Order placed, payment, delivery, refund and renewal reminders on WhatsApp. Off unless you turn it on.",
    "ऑर्डर, भुगतान, डिलीवरी, रिफंड और नवीनीकरण की सूचना WhatsApp पर। जब तक आप चालू न करें, बंद रहेगा।",
    "ऑर्डर, पेमेंट, डिलिव्हरी, रिफंड आणि नूतनीकरणाची सूचना WhatsApp वर. तुम्ही सुरू करेपर्यंत बंद.",
  ),
  stop: L(
    "You can also send STOP on WhatsApp to turn it off, and START to turn it on.",
    "बंद करने के लिए WhatsApp पर STOP भेजें, चालू करने के लिए START।",
    "बंद करण्यासाठी WhatsApp वर STOP पाठवा, सुरू करण्यासाठी START.",
  ),
  noPhone: L(
    "Add and verify your mobile number above to get WhatsApp updates.",
    "WhatsApp अपडेट के लिए ऊपर अपना मोबाइल नंबर जोड़कर सत्यापित करें।",
    "WhatsApp अपडेटसाठी वर तुमचा मोबाईल नंबर जोडून पडताळा.",
  ),
  on: L("On", "चालू", "सुरू"),
  off: L("Off", "बंद", "बंद"),
  failed: L("Your choice could not be saved.", "आपका चुनाव सहेजा नहीं जा सका।", "तुमची निवड जतन झाली नाही."),
};

/**
 * WhatsApp updates (docs/customer-whatsapp-2026-11): opt-in only, and
 * withdrawing is the same single tap (DPDPA §6). Shown only while flag
 * whatsapp_customer_enabled is on.
 */
export function WhatsAppConsentToggle({
  initialGranted,
  lastChangedAt,
  hasVerifiedPhone,
  lang,
}: {
  initialGranted: boolean;
  lastChangedAt: string | null;
  hasVerifiedPhone: boolean;
  lang: Lang;
}) {
  const [granted, setGranted] = useState(initialGranted);
  const [changedAt, setChangedAt] = useState(lastChangedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/consents/whatsapp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granted: next }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? tr(T.failed, lang));
      setGranted(payload.granted);
      setChangedAt(payload.lastChangedAt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(T.failed, lang));
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || (!granted && !hasVerifiedPhone);
  return (
    <div data-testid="whatsapp-consent">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p id="whatsapp-consent-label" className="text-sm font-medium text-ink-800">
            {tr(T.label, lang)}
          </p>
          <p id="whatsapp-consent-hint" className="mt-0.5 text-xs text-ink-500">
            {tr(T.hint, lang)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="w-10 text-right text-sm font-medium text-ink-700" aria-hidden>
            {granted ? tr(T.on, lang) : tr(T.off, lang)}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={granted}
            aria-labelledby="whatsapp-consent-label"
            aria-describedby="whatsapp-consent-hint"
            disabled={disabled}
            onClick={() => change(!granted)}
            className={clsx(
              "tap-target inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              granted ? "bg-kesari-600" : "bg-ink-500",
            )}
          >
            <span className={clsx("inline-block h-5 w-5 rounded-full bg-white shadow transition-transform", granted ? "translate-x-5" : "translate-x-0.5")} />
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs text-ink-500">
        {hasVerifiedPhone ? tr(T.stop, lang) : tr(T.noPhone, lang)}
        {changedAt ? ` (${formatChangedAt(changedAt)})` : null}
      </p>
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </div>
  );
}

function formatChangedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
}
