"use client";

import { useState } from "react";

import { Badge, Button, Card } from "@/components/ui";

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * Shop-refers-shop (0137): the shop's own code and link with share buttons, and
 * how its referrals went. What each side gets comes from rule shopReferrals.
 */
export function ShopReferralCard({
  code,
  link,
  offer,
  summary,
}: {
  code: string;
  link: string;
  /** "10% off their registration fee" / "₹100 welcome credit" and "₹200 promotional credit" / "1 month more membership". */
  offer: { referred: string; referrer: string };
  summary: { pending: number; rewarded: number; rejected: number; earnedPaise: number; extensionMonths: number };
}) {
  const [copied, setCopied] = useState(false);
  const message = `Join GoKesari with my shop's referral code ${code} and get ${offer.referred}: ${link}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  async function share() {
    if (navigator.share) await navigator.share({ title: "GoKesari", text: message, url: link }).catch(() => undefined);
    else await copy();
  }
  return (
    <Card className="space-y-3 p-4" data-testid="shop-referral-card">
      <h2 className="text-base font-bold text-ink-900">Refer another shop</h2>
      <p className="text-sm text-ink-700">
        A shop that registers with your code gets {offer.referred}. When it is approved and delivers its first order, you get {offer.referrer}. Promotional credit pays GoKesari
        commission and delivery charges; it is not paid out to a bank.
      </p>
      <p className="text-2xl font-bold tracking-wider text-kesari-800" data-testid="shop-referral-code">
        {code}
      </p>
      <p className="break-all text-sm text-ink-700" data-testid="shop-referral-link">
        {link}
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          className="inline-flex min-h-11 items-center rounded-lg bg-leaf-700 px-4 text-sm font-semibold text-white"
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Share on WhatsApp
        </a>
        <Button variant="secondary" onClick={share}>
          Share
        </Button>
        <Button variant="ghost" onClick={copy}>
          {copied ? "Link copied" : "Copy link"}
        </Button>
      </div>
      <p className="flex flex-wrap gap-2 text-sm" data-testid="shop-referral-summary">
        <Badge tone="info">{summary.pending} waiting</Badge>
        <Badge tone="success">{summary.rewarded} rewarded</Badge>
        {summary.rejected ? <Badge tone="neutral">{summary.rejected} not eligible</Badge> : null}
        {summary.earnedPaise ? <span>Earned {rs(summary.earnedPaise)}</span> : null}
        {summary.extensionMonths ? <span>+{summary.extensionMonths} month(s) membership</span> : null}
      </p>
    </Card>
  );
}
