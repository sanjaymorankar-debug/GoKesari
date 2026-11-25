/**
 * "Referred by <name>" (docs/referral-sharing-2026-11): on sign-in, first-time setup and Add my shop,
 * for a visitor who opened a referral link (cookie gk_ref_link, set by /r/<code> or the app's first
 * open). In a browser it also offers the app (Play Store / App Store when listed, else GoKesari's own
 * download page): the code survives the install through the deferred link (/app-open).
 * Shows nothing when rule referralSharing is off, the code no longer works, or it is the visitor's own.
 */
import { cookies, headers } from "next/headers";

import { REFERRAL_CLAIM_COOKIE, REFERRAL_LINK_COOKIE } from "@/lib/customer-referrals";
import { parseStoreLink } from "@/lib/app-install";
import { isMobileAppUserAgent } from "@/lib/mobile-app";
import { getCurrentUser } from "@/server/authz/guards";
import { claimDeferredReferral, referralSharingOn, resolveReferralLink } from "@/server/services/referral-links";

export interface ReferredBy {
  name: string;
  level: string;
  code: string;
  inApp: boolean;
  android: string | null;
  ios: string | null;
}

/** The banner's data (or null): awaited by the page, so the page itself never suspends while rendering. */
export async function referredByFor({ audience, code: given }: { audience?: "shop-owner" | "customer"; code?: string | null } = {}): Promise<ReferredBy | null> {
  if (!(await referralSharingOn())) return null;
  const jar = await cookies();
  const code = given || jar.get(REFERRAL_LINK_COOKIE)?.value;
  if (!code) return null;
  const target = await resolveReferralLink(code);
  if (!target.usable || !target.referrerName) return null;
  if (audience && target.audience !== audience) return null;
  const user = await getCurrentUser();
  if (user && target.referrerUserId === user.id) return null;
  const claim = jar.get(REFERRAL_CLAIM_COOKIE)?.value;
  if (user && claim && /^[0-9a-f-]{36}$/i.test(claim)) {
    const h = await headers();
    await claimDeferredReferral(claim, user.id, target, h.get("x-forwarded-for")?.split(",")[0]?.trim() || null, isMobileAppUserAgent(h.get("user-agent")));
  }
  const inApp = isMobileAppUserAgent((await headers()).get("user-agent"));
  const android = parseStoreLink(process.env.MOBILE_APP_ANDROID_URL, "android");
  const ios = parseStoreLink(process.env.MOBILE_APP_IOS_URL, "ios");
  return { name: target.referrerName, level: target.level, code: target.code, inApp, android, ios };
}

/** "Referred by <name>" — synchronous, from referredByFor(). */
export function ReferredByView({ data }: { data: ReferredBy | null }) {
  if (!data) return null;
  const { inApp, android, ios } = data;
  return (
    <div className="mb-4 rounded-xl border border-kesari-200 bg-kesari-50 p-3 text-sm text-ink-800" data-testid="referred-by">
      <p>
        Referred by <strong data-testid="referred-by-name">{data.name}</strong>
        {data.level !== "Customer" && data.level !== "GoKesari" ? <span className="text-ink-500"> ({data.level})</span> : null} — code{" "}
        <span className="font-mono font-semibold">{data.code}</span> is filled in for you.
      </p>
      {!inApp ? (
        <p className="mt-2 flex flex-wrap gap-3 text-sm" data-testid="referred-by-app">
          <span className="text-ink-500">Prefer the app? Your referral stays with you after installing.</span>
          {android ? <a className="font-semibold text-kesari-700 underline" href={android}>Google Play</a> : <a className="font-semibold text-kesari-700 underline" href="/app">Android app</a>}
          {ios ? <a className="font-semibold text-kesari-700 underline" href={ios}>App Store</a> : null}
        </p>
      ) : null}
    </div>
  );
}

/** Convenience for pages that render it as an async server component. */
export async function ReferredByBanner(props: { audience?: "shop-owner" | "customer"; code?: string | null }) {
  return <ReferredByView data={await referredByFor(props)} />;
}
