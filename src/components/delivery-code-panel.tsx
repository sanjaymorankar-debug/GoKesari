"use client";

import { useState } from "react";

import { Button } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Wording (Module 6, docs/hindi-marathi-2026-11/). */
const T = {
  locked: L(
    "Too many wrong delivery codes were entered, so this delivery is on hold. Our support team will contact you",
    "बहुत बार गलत डिलीवरी कोड डाला गया, इसलिए यह डिलीवरी रोकी गई है। हमारी सपोर्ट टीम आपसे संपर्क करेगी",
    "खूप वेळा चुकीचा डिलिव्हरी कोड टाकला गेला, म्हणून ही डिलिव्हरी थांबवली आहे. आमची सपोर्ट टीम तुमच्याशी संपर्क करेल",
  ),
  ticket: L(" (ticket {n})", " (टिकट {n})", " (तिकीट {n})"),
  failed: L("Could not get a new code.", "नया कोड नहीं मिल सका।", "नवीन कोड मिळाला नाही."),
  codeLabel: L("Delivery code:", "डिलीवरी कोड:", "डिलिव्हरी कोड:"),
  codeShare: L(
    "— share it with the rider only when you receive your order. Your earlier code no longer works.",
    "— ऑर्डर मिलने पर ही इसे राइडर को बताएँ। आपका पिछला कोड अब काम नहीं करेगा।",
    "— ऑर्डर मिळाल्यावरच तो रायडरला सांगा. तुमचा आधीचा कोड आता चालणार नाही.",
  ),
  emailed: L(
    "Your delivery code was emailed to {n}. Share it with the rider only when you receive your order.",
    "आपका डिलीवरी कोड {n} पर ईमेल किया गया है। ऑर्डर मिलने पर ही इसे राइडर को बताएँ।",
    "तुमचा डिलिव्हरी कोड {n} वर ईमेल केला आहे. ऑर्डर मिळाल्यावरच तो रायडरला सांगा.",
  ),
  sending: L("Sending…", "भेज रहे हैं…", "पाठवत आहे…"),
  another: L("Get another code", "एक और कोड पाएँ", "आणखी एक कोड मिळवा"),
  newCode: L("Get a new code", "नया कोड पाएँ", "नवीन कोड मिळवा"),
} as const;

/**
 * The customer's delivery code on an order that is on the way. The code is
 * stored only as a hash, so the page cannot show the one that was emailed;
 * "Get a new code" issues a fresh one (the old one stops working), emails it
 * and shows it here once. Rate-limited by the server.
 */
export function DeliveryCodePanel({
  orderId,
  maskedEmail,
  locked,
  ticketNumber,
  resendsLeft,
  lang = "en",
}: {
  orderId: string;
  maskedEmail: string;
  locked: boolean;
  ticketNumber: string | null;
  resendsLeft: number;
  lang?: Lang;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(resendsLeft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (locked) {
    return (
      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="delivery-code-locked">
        {tr(T.locked, lang)}
        {ticketNumber ? tr(T.ticket, lang).replace("{n}", ticketNumber) : ""}{lang === "hi" ? "।" : "."}
      </p>
    );
  }

  async function newCode() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/orders/${orderId}/delivery-code`, { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ? errorText(payload.error.message, lang, payload.error.code) : tr(T.failed, lang));
      setCode(payload.code);
      setLeft(payload.resendsLeft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(T.failed, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg bg-leaf-50 px-3 py-2 text-sm text-leaf-700" data-testid="delivery-otp">
      {code ? (
        <p>
          {tr(T.codeLabel, lang)} <span className="font-mono text-lg font-bold tracking-widest">{code}</span> {tr(T.codeShare, lang)}
        </p>
      ) : (
        <p>
          {tr(T.emailed, lang).replace("{n}", maskedEmail)}
        </p>
      )}
      {left > 0 ? (
        <div className="mt-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void newCode()}>
            {tr(busy ? T.sending : code ? T.another : T.newCode, lang)}
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
