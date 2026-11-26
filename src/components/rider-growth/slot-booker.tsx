"use client";

/**
 * My Slots: the bookable slots for the next days, grouped by day, with their pay boost, booked
 * count against capacity, and Book / Cancel. Booking is optional; the server checks every rule.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button } from "@/components/ui";
import { tr, type Lang } from "@/lib/board/i18n";

import { RG, fill } from "./text";

export interface SlotItem {
  slotId: string;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  boost: string[];
  booked: number;
  capacity: number | null;
  full: boolean;
  myBookingId: string | null;
  canBook: boolean;
  canCancel: boolean;
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new Error(payload?.error?.message ?? "Something went wrong. Please try again.");
  }
}

function dayLabel(date: string, index: number, lang: Lang): string {
  if (index === 0) return tr(RG.today, lang);
  if (index === 1) return tr(RG.tomorrow, lang);
  const [y, m, d] = date.split("-").map(Number);
  const tag = lang === "en" ? "en-IN" : lang === "hi" ? "hi-IN" : "mr-IN";
  return new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function SlotBooker({ days, cancelCutoffMinutes, lang }: { days: { date: string; slots: SlotItem[] }[]; cancelCutoffMinutes: number; lang: Lang }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = (x: (typeof RG)[keyof typeof RG]) => tr(x, lang);

  async function act(key: string, url: string, body: unknown) {
    setError(null);
    setBusy(key);
    try {
      await post(url, body);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="rider-slot-booker">
      <p className="text-xs text-ink-500">{fill(t(RG.cancelRule), { m: cancelCutoffMinutes })}</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {days.map((day, i) => (
        <section key={day.date} className="rounded-2xl border-2 border-cream-200 bg-white p-3" data-testid="rider-slot-day">
          <h2 className="px-1 text-base font-bold text-ink-900">{dayLabel(day.date, i, lang)}</h2>
          {day.slots.length === 0 ? (
            <p className="px-1 py-2 text-sm text-ink-500">{t(RG.noSlots)}</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {day.slots.map((s) => {
                const key = `${s.slotId}:${s.date}`;
                return (
                  <li
                    key={key}
                    className={`rounded-xl border-2 p-3 ${s.myBookingId ? "border-kesari-500 bg-kesari-50" : "border-cream-200 bg-cream-50"}`}
                    data-testid="rider-slot"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-ink-900">{s.name}</p>
                        <p className="text-sm text-ink-700">
                          {s.startTime}–{s.endTime}
                        </p>
                      </div>
                      <p className="text-xs text-ink-600">
                        {s.capacity != null ? `${s.booked}/${s.capacity} ${t(RG.spots)}` : `${s.booked} ${t(RG.spots)}`}
                      </p>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {s.boost.length === 0 ? (
                        <span className="rounded-full bg-cream-200 px-2 py-0.5 text-xs text-ink-700">{t(RG.normalPay)}</span>
                      ) : (
                        s.boost.map((b) => (
                          <span key={b} className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800" data-testid="rider-slot-boost">
                            {b}
                          </span>
                        ))
                      )}
                    </div>
                    <div className="mt-3">
                      {s.myBookingId ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-kesari-600 px-3 py-1 text-xs font-bold text-white">{t(RG.booked)}</span>
                          {s.canCancel ? (
                            <Button
                              variant="secondary"
                              className="min-h-12"
                              disabled={busy !== null}
                              onClick={() => void act(key, "/api/delivery-partner/slots/cancel", { bookingId: s.myBookingId })}
                            >
                              {busy === key ? t(RG.cancelling) : t(RG.cancel)}
                            </Button>
                          ) : (
                            <span className="text-xs text-ink-500">{t(RG.tooLateToCancel)}</span>
                          )}
                        </div>
                      ) : s.full ? (
                        <span className="rounded-full bg-cream-200 px-3 py-1 text-xs font-semibold text-ink-700">{t(RG.full)}</span>
                      ) : s.canBook ? (
                        <Button
                          className="min-h-12 w-full min-[400px]:w-auto"
                          disabled={busy !== null}
                          onClick={() => void act(key, "/api/delivery-partner/slots/book", { slotId: s.slotId, date: s.date })}
                        >
                          {busy === key ? t(RG.booking) : t(RG.book)}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
