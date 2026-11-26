"use client";

/**
 * Refer & Earn share box: the rider's code, copy-link and WhatsApp share. The link is built from
 * the page's own origin, so it works the same on gokesari.com, staging and inside the app's WebView.
 */
import { useState, useSyncExternalStore } from "react";

import { tr, type Lang } from "@/lib/board/i18n";

import { RG, fill } from "./text";

const noSubscribe = () => () => {};

export function ReferShare({ code, lang }: { code: string; lang: Lang }) {
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => "https://gokesari.com");
  const [copied, setCopied] = useState(false);
  const link = `${origin}/delivery-partner/register?ref=${encodeURIComponent(code)}`;
  const message = fill(tr(RG.shareMessage, lang), { code, link });

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Older WebViews: select-and-copy fallback.
      const area = document.createElement("textarea");
      area.value = link;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-2xl border-2 border-kesari-200 bg-kesari-50 p-4" data-testid="rider-referral-share">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-600">{tr(RG.yourCode, lang)}</p>
      <p className="mt-1 break-all font-mono text-3xl font-bold tracking-widest text-kesari-700" data-testid="rider-referral-code">
        {code}
      </p>
      <p className="mt-2 break-all text-xs text-ink-600">{link}</p>
      <div className="mt-4 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
        <a
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-12 items-center justify-center rounded-xl bg-green-700 px-4 text-sm font-bold text-white hover:bg-green-800"
          data-testid="rider-referral-whatsapp"
        >
          {tr(RG.shareWhatsApp, lang)}
        </a>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex min-h-12 items-center justify-center rounded-xl border-2 border-kesari-600 bg-white px-4 text-sm font-bold text-kesari-700 hover:bg-kesari-100"
          data-testid="rider-referral-copy"
        >
          {copied ? tr(RG.copied, lang) : tr(RG.copyLink, lang)}
        </button>
      </div>
    </div>
  );
}
