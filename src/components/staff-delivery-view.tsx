"use client";

import { useState } from "react";

import { Alert, Button, Card, Money } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Wording (Module 6, docs/hindi-marathi-2026-11/). */
const T = {
  wrong: L("Something went wrong.", "कुछ गड़बड़ हो गई।", "काहीतरी चुकले."),
  deliveryFor: L("delivery for", "डिलीवरी:", "डिलिव्हरी:"),
  order: L("Order {n}", "ऑर्डर {n}", "ऑर्डर {n}"),
  delivered: L("Delivered", "डिलीवर हुआ", "पोहोचली"),
  thanks: L("Thank you — this delivery is complete.", "धन्यवाद — यह डिलीवरी पूरी हो गई।", "धन्यवाद — ही डिलिव्हरी पूर्ण झाली."),
  closed: L(
    "This delivery is no longer open. Ask the shop if you need anything.",
    "यह डिलीवरी अब खुली नहीं है। कुछ चाहिए तो दुकान से पूछें।",
    "ही डिलिव्हरी आता उघडी नाही. काही हवे असल्यास दुकानाला विचारा.",
  ),
  landmark: L("Landmark:", "पहचान:", "खूण:"),
  note: L("Note:", "नोट:", "टीप:"),
  callCustomer: L("Call customer", "ग्राहक को कॉल करें", "ग्राहकाला कॉल करा"),
  directions: L("Directions", "रास्ता", "मार्ग"),
  callShop: L("Call shop", "दुकान को कॉल करें", "दुकानाला कॉल करा"),
  items: L("Items", "सामान", "वस्तू"),
  cod: L("Cash on delivery", "कैश ऑन डिलीवरी", "कॅश ऑन डिलिव्हरी"),
  collect: L("Collect", "ग्राहक से", "ग्राहकाकडून"),
  fromCustomer: L("from the customer.", "लें।", "घ्या."),
  onHold: L("On hold", "रुका हुआ", "थांबवले"),
  tooMany: L(
    "Too many wrong codes. Support will confirm this delivery with the customer.",
    "बहुत बार गलत कोड डाला गया। सपोर्ट टीम ग्राहक से यह डिलीवरी पक्की करेगी।",
    "खूप वेळा चुकीचा कोड टाकला. सपोर्ट टीम ग्राहकाशी ही डिलिव्हरी निश्चित करेल.",
  ),
  starting: L("Starting…", "शुरू हो रहा है…", "सुरू होत आहे…"),
  start: L("I have the order — start delivery", "ऑर्डर मेरे पास है — डिलीवरी शुरू करें", "ऑर्डर माझ्याकडे आहे — डिलिव्हरी सुरू करा"),
  codeLabel: L("Customer's delivery code", "ग्राहक का डिलीवरी कोड", "ग्राहकाचा डिलिव्हरी कोड"),
  codeHint: L(
    "Ask the customer for the 4-digit code in their order or email.",
    "ग्राहक से उनके ऑर्डर या ईमेल में आया 4 अंकों का कोड माँगें।",
    "ग्राहकाकडून त्यांच्या ऑर्डर किंवा ईमेलमधील 4 अंकी कोड मागा.",
  ),
  cashCollected: L("I collected the cash", "मैंने नकद ले लिया", "मी रोख रक्कम घेतली"),
  checking: L("Checking…", "जाँच हो रही है…", "तपासत आहे…"),
  confirm: L("Confirm delivery", "डिलीवरी पक्की करें", "डिलिव्हरी निश्चित करा"),
} as const;

export interface StaffDeliveryData {
  orderNumber: string;
  status: string;
  shopName: string;
  shopPhone: string | null;
  staffName: string;
  whenLabel: string;
  customer: {
    name: string;
    phone: string | null;
    address: string;
    landmark: string | null;
    instructions: string | null;
    mapsUrl: string | null;
  } | null;
  items: { name: string; quantity: string }[];
  cashToCollectPaise: number | null;
  locked: boolean;
  canStart: boolean;
  canComplete: boolean;
}

/**
 * What the shop's own delivery person sees on their delivery link
 * (docs/four-features-2026-10): where to go, whom to call, what to collect,
 * and the box for the customer's delivery code. Built for a phone.
 */
export function StaffDeliveryView({ token, initial, lang = "en" }: { token: string; initial: StaffDeliveryData; lang?: Lang }) {
  const [data, setData] = useState(initial);
  const [code, setCode] = useState("");
  const [cash, setCash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/delivery-link/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ? errorText(payload.error.message, lang, payload.error.code) : tr(T.wrong, lang));
      setData(payload);
      setCode("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(T.wrong, lang));
    } finally {
      setBusy(false);
    }
  }

  const delivered = data.status === "DELIVERED";

  return (
    <div className="mx-auto max-w-md space-y-4" data-testid="staff-delivery">
      <div>
        <p className="text-xs uppercase tracking-wide text-ink-500">{data.shopName} · {tr(T.deliveryFor, lang)} {data.staffName}</p>
        <h1 className="text-2xl font-semibold text-ink-900">{tr(T.order, lang).replace("{n}", data.orderNumber)}</h1>
        <p className="text-sm text-ink-600">{data.whenLabel}</p>
      </div>

      {delivered ? (
        <Alert tone="success" title={tr(T.delivered, lang)}>{tr(T.thanks, lang)}</Alert>
      ) : !data.customer ? (
        <Alert tone="info">{tr(T.closed, lang)}</Alert>
      ) : (
        <>
          <Card className="space-y-2 p-4 text-sm">
            <p className="font-medium text-ink-900">{data.customer.name}</p>
            <p className="text-ink-700">{data.customer.address}</p>
            {data.customer.landmark ? <p className="text-ink-600">{tr(T.landmark, lang)} {data.customer.landmark}</p> : null}
            {data.customer.instructions ? <p className="text-ink-600">{tr(T.note, lang)} {data.customer.instructions}</p> : null}
            <div className="flex flex-wrap gap-2 pt-1">
              {data.customer.phone ? (
                <a href={`tel:${data.customer.phone}`} className="rounded-lg border border-cream-200 px-3 py-2 font-medium text-ink-800">
                  {tr(T.callCustomer, lang)}
                </a>
              ) : null}
              {data.customer.mapsUrl ? (
                <a href={data.customer.mapsUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-cream-200 px-3 py-2 font-medium text-kesari-700">
                  {tr(T.directions, lang)}
                </a>
              ) : null}
              {data.shopPhone ? (
                <a href={`tel:${data.shopPhone}`} className="rounded-lg border border-cream-200 px-3 py-2 font-medium text-ink-700">
                  {tr(T.callShop, lang)}
                </a>
              ) : null}
            </div>
          </Card>

          {data.items.length > 0 ? (
            <Card className="p-4 text-sm">
              <p className="mb-1 font-medium text-ink-900">{tr(T.items, lang)}</p>
              <ul className="space-y-0.5 text-ink-700">
                {data.items.map((item, index) => (
                  <li key={index}>
                    {item.name} · {item.quantity}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {data.cashToCollectPaise != null ? (
            <Alert tone="warning" title={tr(T.cod, lang)}>
              {tr(T.collect, lang)} <Money paise={data.cashToCollectPaise} /> {tr(T.fromCustomer, lang)}
            </Alert>
          ) : null}

          {data.locked ? (
            <Alert tone="danger" title={tr(T.onHold, lang)}>{tr(T.tooMany, lang)}</Alert>
          ) : null}

          {data.canStart ? (
            <Button size="lg" className="w-full" disabled={busy} onClick={() => void act({ action: "start" })}>
              {tr(busy ? T.starting : T.start, lang)}
            </Button>
          ) : null}

          {data.canComplete ? (
            <Card className="p-4">
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act({ action: "complete", code, cashCollected: cash });
                }}
              >
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-ink-700">{tr(T.codeLabel, lang)}</span>
                  <input
                    className="w-full rounded-lg border border-cream-200 px-3 py-3 text-center font-mono text-2xl tracking-[0.5em]"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={4}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    aria-label={tr(T.codeLabel, lang)}
                  />
                  <span className="mt-1 block text-xs text-ink-500">{tr(T.codeHint, lang)}</span>
                </label>
                {data.cashToCollectPaise != null ? (
                  <label className="flex items-center gap-2 text-sm text-ink-700">
                    <input type="checkbox" checked={cash} onChange={(e) => setCash(e.target.checked)} className="h-5 w-5 accent-kesari-600" />
                    {tr(T.cashCollected, lang)}
                  </label>
                ) : null}
                <Button type="submit" size="lg" className="w-full" disabled={busy || code.length !== 4 || (data.cashToCollectPaise != null && !cash)}>
                  {tr(busy ? T.checking : T.confirm, lang)}
                </Button>
              </form>
            </Card>
          ) : null}
        </>
      )}

      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
