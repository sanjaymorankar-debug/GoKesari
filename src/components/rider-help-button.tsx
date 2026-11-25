"use client";

/**
 * Rider "Help" (Rider App v2): opens a short form that raises a help-desk ticket (category
 * Delivery) naming the rider's active order, then opens the ticket at /support/{id}. A rider is
 * not the order's buyer or shop, so the help desk does not accept the order id from them; the
 * order number goes in the subject instead. "My tickets" links to /support.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { L, tr, type Lang } from "@/lib/board/i18n";

const T = {
  help: L("Help", "मदद", "मदत"),
  title: L("Get help from GoKesari", "GoKesari से मदद लें", "GoKesari कडून मदत घ्या"),
  aboutOrder: L("About order {o}", "ऑर्डर {o} के बारे में", "ऑर्डर {o} बद्दल"),
  topic: L("What is the problem?", "क्या समस्या है?", "काय अडचण आहे?"),
  topics: {
    PICKUP: L("Problem at pickup", "पिकअप पर समस्या", "पिकअपला अडचण"),
    CUSTOMER: L("Cannot reach the customer", "ग्राहक से संपर्क नहीं हो रहा", "ग्राहकाशी संपर्क होत नाही"),
    ADDRESS: L("Wrong or unclear address", "गलत या अस्पष्ट पता", "चुकीचा किंवा अस्पष्ट पत्ता"),
    PAYMENT: L("Payment or cash problem", "भुगतान या नकद की समस्या", "पेमेंट किंवा रोख रकमेची अडचण"),
    APP: L("App not working", "ऐप काम नहीं कर रहा", "ॲप काम करत नाही"),
    OTHER: L("Something else", "कुछ और", "दुसरे काही"),
  },
  details: L("Tell us what happened", "बताइए क्या हुआ", "काय झाले ते सांगा"),
  detailsHint: L("At least 10 characters.", "कम से कम 10 अक्षर।", "किमान 10 अक्षरे."),
  send: L("Send to support", "सहायता को भेजें", "सहाय्याकडे पाठवा"),
  sending: L("Sending…", "भेज रहे हैं…", "पाठवत आहोत…"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
  myTickets: L("My tickets", "मेरे टिकट", "माझी तिकिटे"),
  tooShort: L("Please describe the problem in a bit more detail.", "कृपया समस्या थोड़ा और विस्तार से बताएँ।", "कृपया अडचण थोडी अधिक सविस्तर सांगा."),
  failed: L("Could not send. Please try again.", "भेज नहीं सके। कृपया फिर से कोशिश करें।", "पाठवता आले नाही. कृपया पुन्हा प्रयत्न करा."),
} as const;

type Topic = keyof typeof T.topics;
const TOPICS = Object.keys(T.topics) as Topic[];

export function RiderHelpButton({ lang, orderNumber, className }: { lang: Lang; orderNumber?: string | null; className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState<Topic>("PICKUP");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (details.trim().length < 10) return setError(tr(T.tooShort, lang));
    setBusy(true);
    try {
      // The ticket is read by English-speaking support: subject in English, the rider's own words below.
      const topicEn = T.topics[topic].en;
      const subject = `Rider help: ${topicEn}${orderNumber ? ` — order ${orderNumber}` : ""}`.slice(0, 200);
      const res = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "DELIVERY",
          subject,
          description: `${orderNumber ? `Order: ${orderNumber}\n` : ""}${details.trim()}`.slice(0, 5000),
          priority: orderNumber ? "HIGH" : "NORMAL",
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.id) throw new Error(payload?.error?.message ?? tr(T.failed, lang));
      router.push(`/support/${payload.id}?created=1`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(T.failed, lang));
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="rider-help-button"
        className={
          className ??
          "inline-flex min-h-11 items-center justify-center rounded-full border border-cream-200 bg-white px-4 text-sm font-semibold text-ink-800 shadow-sm hover:bg-cream-100"
        }
      >
        {tr(T.help, lang)}
      </button>
      {open ? (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 p-4 sm:items-center" role="presentation">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="rider-help-title"
            onSubmit={submit}
            className="max-h-[90vh] w-full max-w-sm space-y-3 overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
            data-testid="rider-help-dialog"
          >
            <h2 id="rider-help-title" className="text-lg font-semibold text-ink-900">
              {tr(T.title, lang)}
            </h2>
            {orderNumber ? <p className="text-sm text-ink-600">{tr(T.aboutOrder, lang).replace("{o}", orderNumber)}</p> : null}
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-sm font-medium text-ink-700">{tr(T.topic, lang)}</legend>
              {TOPICS.map((key) => (
                <label key={key} className="flex min-h-10 items-center gap-2 rounded-lg border border-cream-200 px-3 text-sm text-ink-800">
                  <input type="radio" name="rider-help-topic" value={key} checked={topic === key} onChange={() => setTopic(key)} />
                  {tr(T.topics[key], lang)}
                </label>
              ))}
            </fieldset>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink-700">{tr(T.details, lang)}</span>
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={3}
                maxLength={2000}
                className="w-full rounded-lg border border-cream-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-kesari-500 focus:outline-none"
              />
              <span className="mt-1 block text-xs text-ink-500">{tr(T.detailsHint, lang)}</span>
            </label>
            {error ? (
              <p className="text-sm text-red-700" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              <button
                type="submit"
                disabled={busy}
                className="min-h-11 w-full rounded-lg bg-kesari-600 px-4 text-sm font-semibold text-white hover:bg-kesari-800 disabled:bg-cream-200 disabled:text-ink-600"
              >
                {busy ? tr(T.sending, lang) : tr(T.send, lang)}
              </button>
              <div className="flex gap-2">
                <Link href="/support" className="flex min-h-11 flex-1 items-center justify-center rounded-lg border border-cream-200 text-sm text-ink-700 hover:bg-cream-100">
                  {tr(T.myTickets, lang)}
                </Link>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="min-h-11 flex-1 rounded-lg border border-cream-200 text-sm text-ink-700 hover:bg-cream-100"
                >
                  {tr(T.cancel, lang)}
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
