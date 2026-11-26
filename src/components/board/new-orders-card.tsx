"use client";

import Link from "next/link";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { L, tr, type Lang } from "@/lib/board/i18n";
import { formatRupees } from "@/lib/board/format";
import type { NewOrderCard } from "@/server/services/shop-today";

import { Icon } from "./icons";

/*
 * The top of the shop owner's phone home (docs/ux-mobile-2026-11): "New orders (n)"
 * with the newest two, each with Accept and Reject right there. Reject asks for a
 * reason (one tap on a common one, or typed) — the same call as the Orders page
 * (POST /api/orders/:id/fulfilment). Accepting takes one tap from home.
 */

const T = {
  newOrders: L("New orders", "नए ऑर्डर", "नवीन ऑर्डर"),
  none: L("No new orders right now", "अभी कोई नया ऑर्डर नहीं", "सध्या नवीन ऑर्डर नाहीत"),
  seeAll: L("See all orders", "सभी ऑर्डर देखें", "सर्व ऑर्डर पहा"),
  more: L("{n} more waiting — open Orders", "{n} और इंतज़ार में — ऑर्डर खोलें", "आणखी {n} थांबलेल्या — ऑर्डर उघडा"),
  items: L("{n} items", "{n} आइटम", "{n} वस्तू"),
  item: L("1 item", "1 आइटम", "1 वस्तू"),
  acceptBy: L("Accept by {t}", "{t} तक स्वीकारें", "{t} पर्यंत स्वीकारा"),
  accept: L("Accept", "स्वीकारें", "स्वीकारा"),
  reject: L("Reject", "अस्वीकार", "नाकारा"),
  why: L("Why are you rejecting {o}?", "{o} क्यों अस्वीकार कर रहे हैं?", "{o} का नाकारत आहात?"),
  other: L("Or type a reason", "या कारण लिखें", "किंवा कारण लिहा"),
  confirmReject: L("Reject order", "ऑर्डर अस्वीकार करें", "ऑर्डर नाकारा"),
  cancel: L("Back", "वापस", "मागे"),
  accepted: L("{o} accepted. Start packing from Orders.", "{o} स्वीकार किया। ऑर्डर में पैकिंग शुरू करें।", "{o} स्वीकारली. ऑर्डरमधून पॅकिंग सुरू करा."),
  rejected: L("{o} rejected. The order is cancelled.", "{o} अस्वीकार किया। ऑर्डर रद्द हो गया।", "{o} नाकारली. ऑर्डर रद्द झाली."),
  error: L("Could not update the order. Try again or open Orders.", "ऑर्डर अपडेट नहीं हुआ। फिर कोशिश करें या ऑर्डर खोलें।", "ऑर्डर अपडेट झाली नाही. पुन्हा प्रयत्न करा किंवा ऑर्डर उघडा."),
} as const;

const REASONS = [
  L("Items out of stock", "सामान स्टॉक में नहीं", "माल साठ्यात नाही"),
  L("Shop closed now", "दुकान अभी बंद है", "दुकान आता बंद आहे"),
  L("Can't deliver to this address", "इस पते पर डिलीवरी नहीं हो सकती", "या पत्त्यावर डिलिव्हरी शक्य नाही"),
] as const;

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function NewOrdersCard({ lang, total, orders }: { lang: Lang; total: number; orders: NewOrderCard[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<Record<string, "accepted" | "rejected">>({});
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  if (total === 0 && orders.length === 0) {
    return (
      <Link
        href="/shop/orders"
        data-testid="shop-quick-new-orders"
        className="flex min-h-[4.5rem] items-center gap-3 rounded-2xl border border-[var(--gk-line)] bg-white px-4 py-3 text-ink-900"
      >
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-kesari-100 text-kesari-700">
          <Icon name="package" size={24} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-lg font-bold leading-tight">{tr(T.none, lang)}</span>
          <span className="text-sm text-ink-600">{tr(T.seeAll, lang)} →</span>
        </span>
      </Link>
    );
  }

  async function act(order: NewOrderCard, body: { action: "accept" } | { action: "reject"; reason: string }) {
    setBusy(order.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/fulfilment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new Error(data?.message ?? data?.error ?? tr(T.error, lang));
      }
      const kind = body.action === "accept" ? "accepted" : "rejected";
      setDone((d) => ({ ...d, [order.id]: kind }));
      setRejecting(null);
      setReason("");
      setMessage({ tone: "ok", text: tr(kind === "accepted" ? T.accepted : T.rejected, lang).replace("{o}", order.orderNumber) });
      router.refresh();
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error && e.message ? e.message : tr(T.error, lang) });
    } finally {
      setBusy(null);
    }
  }

  const waiting = orders.filter((o) => !done[o.id]);
  const left = Math.max(0, total - orders.length);

  return (
    <section className="rounded-2xl bg-kesari-700 p-3 text-white shadow-md" data-testid="shop-quick-new-orders-card" aria-labelledby="home-new-orders">
      <Link href="/shop/orders?status=new" data-testid="shop-quick-new-orders" className="flex min-h-11 items-center gap-2 rounded-xl px-1">
        <Icon name="package" size={22} className="shrink-0" />
        <h2 id="home-new-orders" className="min-w-0 flex-1 text-lg font-bold leading-tight">
          {tr(T.newOrders, lang)} ({total})
        </h2>
        <span className="shrink-0 text-sm font-semibold underline">{tr(T.seeAll, lang)}</span>
      </Link>

      {message ? (
        <p role="status" className={clsx("mt-2 rounded-xl px-3 py-2 text-sm font-semibold", message.tone === "ok" ? "bg-white text-green-800" : "bg-white text-red-700")} data-testid="home-order-message">
          {message.tone === "ok" ? "✓ " : ""}
          {message.text}
        </p>
      ) : null}

      <ul className="mt-2 flex flex-col gap-2">
        {waiting.map((o) => (
          <li key={o.id} className="rounded-xl bg-white px-3 py-2.5 text-ink-900" data-testid="home-new-order">
            <div className="flex items-start justify-between gap-2">
              <Link href="/shop/orders?status=new" className="flex min-w-0 flex-1 flex-col items-start text-left leading-tight">
                <span className="font-bold">{o.orderNumber}</span>
                <span className="block text-sm text-ink-600">
                  {(o.items === 1 ? tr(T.item, lang) : tr(T.items, lang).replace("{n}", String(o.items)))} · {time(o.createdAt)}
                </span>
                {o.acceptByAt ? <span className="text-sm font-semibold text-red-700">{tr(T.acceptBy, lang).replace("{t}", time(o.acceptByAt))}</span> : null}
              </Link>
              <span className="shrink-0 text-lg font-bold tabular-nums">{formatRupees(o.totalPaise)}</span>
            </div>

            {rejecting === o.id ? (
              <div className="mt-2 space-y-2" data-testid="home-reject-panel">
                <p className="text-sm font-semibold">{tr(T.why, lang).replace("{o}", o.orderNumber)}</p>
                <div className="flex flex-wrap gap-2">
                  {REASONS.map((r) => (
                    <button
                      key={r.en}
                      type="button"
                      onClick={() => setReason(tr(r, lang))}
                      aria-pressed={reason === tr(r, lang)}
                      className={clsx(
                        "min-h-11 rounded-full border px-3 text-sm font-semibold",
                        reason === tr(r, lang) ? "border-red-700 bg-red-50 text-red-800" : "border-slate-400 bg-white text-ink-800",
                      )}
                    >
                      {tr(r, lang)}
                    </button>
                  ))}
                </div>
                <label className="block text-sm text-ink-700">
                  <span className="sr-only">{tr(T.other, lang)}</span>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={tr(T.other, lang)}
                    maxLength={300}
                    className="h-12 w-full rounded-lg border-[1.5px] border-slate-500 bg-white px-3 text-base focus:border-kesari-700 focus:outline-none focus:ring-4 focus:ring-kesari-300/70"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy === o.id || reason.trim().length < 3}
                    onClick={() => act(o, { action: "reject", reason: reason.trim() })}
                    className="min-h-12 flex-1 rounded-xl bg-red-700 px-3 text-base font-bold text-white disabled:opacity-50"
                    data-testid="home-reject-confirm"
                  >
                    {tr(T.confirmReject, lang)}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRejecting(null);
                      setReason("");
                    }}
                    className="min-h-12 rounded-xl border border-slate-400 px-4 text-base font-semibold text-ink-800"
                  >
                    {tr(T.cancel, lang)}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy === o.id}
                  onClick={() => act(o, { action: "accept" })}
                  className="min-h-11 flex-1 rounded-xl bg-green-700 px-3 text-base font-bold text-white hover:bg-green-800 disabled:opacity-60"
                  data-testid="home-accept"
                >
                  {tr(T.accept, lang)}
                </button>
                <button
                  type="button"
                  disabled={busy === o.id}
                  onClick={() => {
                    setRejecting(o.id);
                    setReason("");
                  }}
                  className="min-h-11 rounded-xl border-2 border-red-700 bg-white px-4 text-base font-bold text-red-700 disabled:opacity-60"
                  data-testid="home-reject"
                >
                  {tr(T.reject, lang)}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {left > 0 ? (
        <Link href="/shop/orders?status=new" className="mt-2 flex min-h-11 items-center justify-center rounded-xl bg-white/15 text-sm font-semibold">
          {tr(T.more, lang).replace("{n}", String(left))}
        </Link>
      ) : null}
    </section>
  );
}
