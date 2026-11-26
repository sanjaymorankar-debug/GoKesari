"use client";

/**
 * Rider App v2: "You earn ₹X" with the pay lines behind it on tap (base,
 * distance, first mile, surge, bonus, minimum top-up). Only the rider's own
 * pay — never the customer's delivery fee, order value or commission.
 */
import { useState } from "react";

import { Money } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";
import type { RiderPayBreakdown } from "@/server/services/rider-job-board";

const T = {
  youEarn: L("You earn", "आपकी कमाई", "तुमची कमाई"),
  locked: L("Locked when you accept", "स्वीकार करने पर पक्की", "स्वीकारल्यावर निश्चित"),
  lockedDone: L("Locked", "पक्की", "निश्चित"),
  show: L("See how", "कैसे बनी देखें", "कशी ते पाहा"),
  hide: L("Hide", "छिपाएँ", "लपवा"),
  base: L("Base pay", "बेस भुगतान", "मूळ रक्कम"),
  distance: L("Distance", "दूरी", "अंतर"),
  firstMile: L("Ride to the shop", "दुकान तक", "दुकानापर्यंत"),
  surge: L("Surge", "सर्ज", "सर्ज"),
  bonus: L("Long-distance bonus", "लंबी दूरी बोनस", "लांब अंतर बोनस"),
  minTopUp: L("Minimum pay top-up", "न्यूनतम भुगतान टॉप-अप", "किमान रक्कम टॉप-अप"),
} as const;

const LINES: { key: keyof RiderPayBreakdown; label: keyof typeof T }[] = [
  { key: "basePaise", label: "base" },
  { key: "distancePaise", label: "distance" },
  { key: "firstMilePaise", label: "firstMile" },
  { key: "surgePaise", label: "surge" },
  { key: "bonusPaise", label: "bonus" },
  { key: "minTopUpPaise", label: "minTopUp" },
];

export function PayBreakdownLines({ breakdown, lang }: { breakdown: RiderPayBreakdown; lang: Lang }) {
  return (
    <dl className="mt-2 space-y-1 text-sm" data-testid="pay-breakdown">
      {LINES.filter((l) => breakdown[l.key] !== 0).map((l) => (
        <div key={l.key} className="flex justify-between gap-2">
          <dt className="text-ink-600">{tr(T[l.label], lang)}</dt>
          <dd className="font-medium text-ink-900">
            <Money paise={breakdown[l.key]} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The big "You earn ₹X" line; tapping shows the breakdown when there is one. */
export function YouEarn({
  earnPaise,
  breakdown,
  locked,
  lang,
}: {
  earnPaise: number;
  breakdown: RiderPayBreakdown | null;
  locked?: boolean;
  lang: Lang;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg bg-green-50 p-3" data-testid="you-earn">
      <button
        type="button"
        className="flex w-full min-h-10 items-center justify-between gap-2 text-left"
        onClick={() => setOpen((o) => !o)}
        disabled={!breakdown}
        aria-expanded={breakdown ? open : undefined}
      >
        <span>
          <span className="block text-xs font-semibold uppercase tracking-wide text-green-800">{tr(T.youEarn, lang)}</span>
          <span className="text-2xl font-bold text-green-900">
            <Money paise={earnPaise} />
          </span>
        </span>
        {breakdown ? <span className="text-sm font-medium text-green-800 underline">{tr(open ? T.hide : T.show, lang)}</span> : null}
      </button>
      {locked !== undefined ? <p className="text-xs text-green-800">{tr(locked ? T.lockedDone : T.locked, lang)}</p> : null}
      {open && breakdown ? <PayBreakdownLines breakdown={breakdown} lang={lang} /> : null}
    </div>
  );
}
