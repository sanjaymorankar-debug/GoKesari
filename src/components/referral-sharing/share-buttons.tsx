"use client";

/**
 * Referral sharing (docs/referral-sharing-2026-11): one set of Share buttons for every referrer —
 * WhatsApp, SMS, Email, the phone's share sheet (Telegram, Messages, copy… — in the GoKesari app the
 * app's own share sheet) and Copy link. Each sends the pre-filled English + local-language message with
 * the referral link /r/<CODE>?c=<channel>, and logs the share (best effort, never blocks it).
 */
import { useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => undefined;

import type { Lang } from "@/lib/board/i18n";
import { channelHref, referralLink, shareMessage, type ShareAudience, type ShareChannel } from "@/lib/referral-share";

function logShare(code: string, channel: ShareChannel) {
  const body = JSON.stringify({ code, channel });
  try {
    void fetch("/api/referral-links/share", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  } catch {
    // never block the share
  }
}

const buttonClass = "inline-flex min-h-11 items-center gap-1 rounded-lg border border-cream-300 bg-white px-3 text-sm font-semibold text-ink-800 hover:bg-cream-50";

export function ReferralShareButtons({
  code,
  who,
  audience,
  origin,
  lang,
  subject,
}: {
  code: string;
  /** The name in the message: "Asha", "Shree Traders", "Ravi (Shree Traders)". */
  who: string;
  audience: ShareAudience;
  /** https://gokesari.com (the site the page was opened on). */
  origin: string;
  lang?: Lang | null;
  subject?: string;
}) {
  const [copied, setCopied] = useState(false);
  // The share sheet exists in phone browsers and (bridged) in the GoKesari app; never during server rendering.
  const canNativeShare = useSyncExternalStore(
    noSubscribe,
    () => typeof navigator.share === "function",
    () => false,
  );

  const messageFor = (channel: ShareChannel) => shareMessage({ code, who, audience, link: referralLink(origin, code, channel), lang });

  async function nativeShare() {
    logShare(code, "native");
    try {
      await navigator.share({ title: subject ?? "GoKesari", text: messageFor("native") });
    } catch {
      // cancelled
    }
  }
  async function copy() {
    logShare(code, "copy");
    try {
      await navigator.clipboard.writeText(referralLink(origin, code, "copy"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2" data-testid="referral-share-buttons" data-code={code}>
      <a className={buttonClass} href={channelHref("whatsapp", messageFor("whatsapp"))} target="_blank" rel="noopener noreferrer" onClick={() => logShare(code, "whatsapp")} data-testid="share-whatsapp">
        WhatsApp
      </a>
      <a className={buttonClass} href={channelHref("sms", messageFor("sms"))} onClick={() => logShare(code, "sms")} data-testid="share-sms">
        SMS
      </a>
      <a className={buttonClass} href={channelHref("email", messageFor("email"), subject)} onClick={() => logShare(code, "email")} data-testid="share-email">
        Email
      </a>
      {canNativeShare ? (
        <button type="button" className={buttonClass} onClick={() => void nativeShare()} data-testid="share-native">
          More…
        </button>
      ) : null}
      <button type="button" className={buttonClass} onClick={() => void copy()} data-testid="share-copy">
        {copied ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}
