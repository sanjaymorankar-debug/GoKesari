"use client";

import { useState } from "react";

import { Button, inputClass } from "@/components/ui";
import { tr, type Lang } from "@/lib/board/i18n";

/**
 * Onboarding WP6 (docs/onboarding-waves-2-3-2026-11): "No code? Find one near you" on the wizard's
 * first screen. The owner types the shop's PIN code and sees the approved dealers who cover it
 * (GET /api/referral-codes/by-pincode), closest area first; "Use this code" fills the referral
 * code field. The call button shows only when the server sent a phone (signed-in callers only).
 * Shown only while flag onboarding_referral_by_pin_enabled is on (the page passes it).
 */

interface DealerCard {
  displayName: string;
  area: string;
  code: string;
  phone: string | null;
}

export function ReferralByPin({ initialPin, onUse, lang }: { initialPin: string | null; onUse: (code: string) => void; lang: Lang }) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState(initialPin ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [found, setFound] = useState<{ area: string | null; dealers: DealerCard[] } | null>(null);

  async function search() {
    const value = pin.trim();
    if (!/^[1-9][0-9]{5}$/.test(value)) {
      setProblem(tr({ en: "Enter the 6-digit PIN code of your shop.", hi: "अपनी दुकान का 6 अंकों का पिन कोड दर्ज करें।", mr: "तुमच्या दुकानाचा 6 अंकी पिन कोड टाका." }, lang));
      return;
    }
    setBusy(true);
    setProblem(null);
    const response = await fetch(`/api/referral-codes/by-pincode?pin=${value}`).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setBusy(false);
    if (!response?.ok || !payload) {
      setFound(null);
      setProblem(payload?.error?.message ?? tr({ en: "Could not look this up. Please try again.", hi: "यह खोजा नहीं जा सका। कृपया फिर से कोशिश करें।", mr: "हे शोधता आले नाही. कृपया पुन्हा प्रयत्न करा." }, lang));
      return;
    }
    setFound({ area: payload.area ?? null, dealers: payload.dealers ?? [] });
  }

  return (
    <details className="rounded-lg border border-cream-200 bg-white px-3 py-2 text-sm text-ink-700" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid="referral-by-pin">
      <summary className="min-h-11 cursor-pointer py-2 font-semibold text-kesari-700">
        {tr({ en: "No code? Find one near you", hi: "कोड नहीं है? अपने पास खोजें", mr: "कोड नाही? जवळपास शोधा" }, lang)}
      </summary>
      {open ? (
        <div className="space-y-3 pb-2">
          <div className="flex gap-2">
            <input
              className={`${inputClass} font-mono`}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="postal-code"
              placeholder="411038"
              aria-label={tr({ en: "Shop PIN code", hi: "दुकान का पिन कोड", mr: "दुकानाचा पिन कोड" }, lang)}
              data-testid="referral-pin-input"
            />
            <Button type="button" onClick={() => void search()} disabled={busy} data-testid="referral-pin-search">
              {busy ? tr({ en: "Finding…", hi: "खोज रहे हैं…", mr: "शोधत आहे…" }, lang) : tr({ en: "Find", hi: "खोजें", mr: "शोधा" }, lang)}
            </Button>
          </div>
          {problem ? <p className="text-red-700" role="alert">{problem}</p> : null}
          {found && found.dealers.length === 0 ? (
            <p data-testid="referral-pin-none">
              {tr({ en: "No GoKesari dealer covers this PIN code yet. You can request a code, or go on without one if it is optional.", hi: "इस पिन कोड के लिए अभी कोई GoKesari डीलर नहीं है। आप कोड का अनुरोध कर सकते हैं, या वैकल्पिक हो तो उसके बिना आगे बढ़ें।", mr: "या पिन कोडसाठी अजून GoKesari डीलर नाही. तुम्ही कोडची विनंती करू शकता, किंवा तो पर्यायी असल्यास त्याशिवाय पुढे जा." }, lang)}
            </p>
          ) : null}
          {found && found.dealers.length > 0 ? (
            <ul className="space-y-2" data-testid="referral-pin-dealers">
              {found.dealers.map((d) => (
                <li key={d.code} className="rounded-lg border border-cream-200 p-3">
                  <strong className="block text-ink-900">{d.displayName}</strong>
                  <span className="block text-ink-600">
                    {d.area} · <span className="font-mono">{d.code}</span>
                  </span>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={() => onUse(d.code)} data-testid="referral-pin-use">
                      {tr({ en: "Use this code", hi: "यह कोड इस्तेमाल करें", mr: "हा कोड वापरा" }, lang)}
                    </Button>
                    {d.phone ? (
                      <a href={`tel:${d.phone.replace(/\s+/g, "")}`} className="inline-flex min-h-9 items-center rounded-lg border border-cream-200 px-3 text-sm font-medium text-ink-700" data-testid="referral-pin-call">
                        📞 {tr({ en: "Call", hi: "कॉल करें", mr: "कॉल करा" }, lang)}
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
