"use client";

/**
 * Rider App v2 Home: "High-earning slot live" — the peak slot (surge multiplier
 * or peak bonus) and manual surges live now for the rider's area, with the IST
 * window and "+X% / +₹Y per order", and a Go online button while offline.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";
import { formatPaiseCompact } from "@/lib/money";
import type { SurgeBannerItem } from "@/server/services/rider-home";

import { requestAvailability } from "./availability";

const T = {
  live: L("High-earning slot live", "ज़्यादा कमाई का समय चालू", "जास्त कमाईची वेळ सुरू"),
  window: L("{from}–{to} IST", "{from}–{to} IST", "{from}–{to} IST"),
  pct: L("+{n}%", "+{n}%", "+{n}%"),
  flat: L("+{amount} per order", "हर ऑर्डर पर +{amount}", "प्रत्येक ऑर्डरवर +{amount}"),
  goOnline: L("Go online", "ऑनलाइन हों", "ऑनलाइन व्हा"),
} as const;

export function HighEarningBanner({ items, online, canGoOnline, lang }: { items: SurgeBannerItem[]; online: boolean; canGoOnline: boolean; lang: Lang }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (items.length === 0) return null;

  async function goOnline() {
    setBusy(true);
    setError(null);
    try {
      const result = await requestAvailability("READY", lang);
      if (!result.ok && result.error) setError(result.error);
      if (result.ok || result.refresh) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl bg-gradient-to-r from-amber-500 to-kesari-600 p-4 text-white shadow-md" data-testid="high-earning-banner">
      <p className="text-xs font-bold uppercase tracking-wide">⚡ {tr(T.live, lang)}</p>
      <ul className="mt-2 space-y-1.5">
        {items.map((item, i) => (
          <li key={`${item.label}-${i}`} className="text-sm">
            <span className="font-bold">{item.label}</span> · {tr(T.window, lang).replace("{from}", item.from).replace("{to}", item.to)}
            <span className="block text-base font-extrabold">
              {[
                item.extraPct > 0 ? tr(T.pct, lang).replace("{n}", String(item.extraPct)) : null,
                item.flatPaise > 0 ? tr(T.flat, lang).replace("{amount}", formatPaiseCompact(item.flatPaise)) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {!online && canGoOnline ? (
        <Button size="md" variant="secondary" className="mt-3 w-full font-bold text-kesari-800" disabled={busy} onClick={goOnline}>
          {tr(T.goOnline, lang)}
        </Button>
      ) : null}
      {error ? <p className="mt-2 rounded bg-white/90 p-2 text-sm text-red-800">{error}</p> : null}
    </section>
  );
}
