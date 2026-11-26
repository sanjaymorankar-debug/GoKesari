"use client";

/**
 * Rider App v2 (rule riderAppV2): the header on every rider page — a big
 * Online/Offline switch (the same Offline / Ready change as the dashboard's
 * availability card, rider-shell/availability.ts), Help, SOS (rule riderSos)
 * and the tier badge (rule riderTiers, from GET /api/delivery-partner/tier).
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import clsx from "clsx";

import { RiderHelpButton } from "@/components/rider-help-button";
import { RiderSosButton } from "@/components/rider-sos-button";
import { L, tr, type Lang } from "@/lib/board/i18n";

import { requestAvailability, type RiderAvailability } from "./availability";

const T = {
  online: L("Online", "ऑनलाइन", "ऑनलाइन"),
  offline: L("Offline", "ऑफ़लाइन", "ऑफलाइन"),
  goOnline: L("Tap to go online", "ऑनलाइन होने के लिए दबाएँ", "ऑनलाइन होण्यासाठी दाबा"),
  goOffline: L("Tap to go offline", "ऑफ़लाइन होने के लिए दबाएँ", "ऑफलाइन होण्यासाठी दाबा"),
  working: L("Please wait…", "कृपया रुकें…", "कृपया थांबा…"),
  finishFirst: L("Finish your delivery to go offline", "ऑफ़लाइन होने से पहले डिलीवरी पूरी करें", "ऑफलाइन होण्यापूर्वी डिलिव्हरी पूर्ण करा"),
  verifyFirst: L("Finish verification to go online", "ऑनलाइन होने के लिए सत्यापन पूरा करें", "ऑनलाइन होण्यासाठी पडताळणी पूर्ण करा"),
  switchLabel: L("Online for deliveries", "डिलीवरी के लिए ऑनलाइन", "डिलिव्हरीसाठी ऑनलाइन"),
} as const;

interface TierBadge {
  name: string;
}

export function RiderHeader({
  availability: serverAvailability,
  canGoOnline,
  hasActiveDelivery,
  sosNumber,
  tiersOn,
  activeOrderNumber = null,
  lang,
}: {
  availability: RiderAvailability;
  /** The verification gate (KYC, police documents) allows Active / Ready. */
  canGoOnline: boolean;
  hasActiveDelivery: boolean;
  /** Rule riderSos on: the number SOS dials; null hides the button. */
  sosNumber: string | null;
  tiersOn: boolean;
  activeOrderNumber?: string | null;
  lang: Lang;
}) {
  const router = useRouter();
  const [availability, setAvailability] = useState<RiderAvailability>(serverAvailability);
  const [seen, setSeen] = useState(serverAvailability);
  if (seen !== serverAvailability) {
    setSeen(serverAvailability);
    setAvailability(serverAvailability);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState<TierBadge | null>(null);
  const online = availability !== "OFFLINE";

  useEffect(() => {
    if (!tiersOn) return;
    let cancelled = false;
    fetch("/api/delivery-partner/tier", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { enabled?: boolean; tier?: TierBadge | null } | null) => {
        if (!cancelled && body?.enabled && body.tier?.name) setTier({ name: body.tier.name });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tiersOn]);

  const blocked = online ? hasActiveDelivery : !canGoOnline;

  async function toggle() {
    if (busy || blocked) return;
    setError(null);
    setBusy(true);
    const target: RiderAvailability = online ? "OFFLINE" : "READY";
    try {
      const result = await requestAvailability(target, lang);
      if (result.ok) {
        setAvailability(target);
        router.refresh();
        return;
      }
      if (result.error) setError(result.error);
      if (result.refresh) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="mx-auto mb-4 max-w-2xl rounded-2xl border border-cream-200 bg-white p-2 shadow-sm" data-testid="rider-header">
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={online}
          aria-label={tr(T.switchLabel, lang)}
          onClick={toggle}
          disabled={busy || blocked}
          data-testid="rider-online-toggle"
          className={clsx(
            "flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-full border px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed",
            online ? "border-green-700 bg-green-50" : "border-cream-200 bg-cream-50",
          )}
        >
          <span className={clsx("relative h-8 w-14 shrink-0 rounded-full transition-colors", online ? "bg-green-700" : "bg-ink-400")} aria-hidden>
            <span className={clsx("absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all", online ? "left-7" : "left-1")} />
          </span>
          <span className="min-w-0">
            <span className={clsx("block text-base font-bold leading-tight", online ? "text-green-900" : "text-ink-800")}>
              {tr(online ? T.online : T.offline, lang)}
            </span>
            <span className="block truncate text-xs text-ink-600">
              {busy
                ? tr(T.working, lang)
                : blocked
                  ? tr(online ? T.finishFirst : T.verifyFirst, lang)
                  : tr(online ? T.goOffline : T.goOnline, lang)}
            </span>
          </span>
        </button>
        {tier ? (
          <a
            href="/delivery-partner/tier"
            className="hidden shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 min-[400px]:inline-block"
            data-testid="rider-tier-badge"
          >
            ★ {tier.name}
          </a>
        ) : null}
        <RiderHelpButton lang={lang} orderNumber={activeOrderNumber} />
        {sosNumber ? <RiderSosButton emergencyNumber={sosNumber} lang={lang} /> : null}
      </div>
      {tier ? (
        <a href="/delivery-partner/tier" className="mt-1 inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-800 min-[400px]:hidden">
          ★ {tier.name}
        </a>
      ) : null}
      {error ? (
        <p className="mt-1 px-1 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </header>
  );
}
