"use client";

import Link from "next/link";
import clsx from "clsx";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon } from "@/components/board/icons";
import { L, tr, type Lang } from "@/lib/board/i18n";

/*
 * The delivery partner's bottom tab bar on phones and tablets (docs/ux-mobile-2026-11):
 * Home (today's trip and availability) · Earnings · Payouts · Documents · Account.
 * Fixed above the iPhone home bar; each tab is a fifth of the screen and 64 px tall.
 * Not shown while applying or registering, or on the full-screen navigation map.
 * Desktop keeps the page as it is.
 */

const TEXT = {
  tabs: L("Delivery partner tabs", "डिलीवरी पार्टनर टैब", "डिलिव्हरी पार्टनर टॅब"),
  home: L("Home", "होम", "होम"),
  earnings: L("Earnings", "कमाई", "कमाई"),
  payouts: L("Payouts", "भुगतान", "पेमेंट"),
  documents: L("Documents", "दस्तावेज़", "कागदपत्रे"),
  account: L("Account", "खाता", "खाते"),
} as const;

const HIDDEN = ["/delivery-partner/apply", "/delivery-partner/register", "/delivery-partner/navigate"];

type Key = "home" | "earnings" | "payouts" | "documents" | "account";

const TABS: { key: Key; href: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
  { key: "home", href: "/delivery-partner", icon: "house" },
  { key: "earnings", href: "/delivery-partner#rider-earnings", icon: "indian-rupee" },
  { key: "payouts", href: "/delivery-partner#rider-payouts", icon: "wallet" },
  { key: "documents", href: "/delivery-partner/documents", icon: "file-text" },
  { key: "account", href: "/profile", icon: "user" },
];

/** `approved`: Earnings and Payouts exist on the home page only once the rider is approved; until then those tabs are left out. */
export function RiderBottomNav({ lang, approved }: { lang: Lang; approved: boolean }) {
  const pathname = usePathname();
  const [hash, setHash] = useState("");
  useEffect(() => {
    const read = () => setHash(window.location.hash);
    const frame = requestAnimationFrame(read);
    window.addEventListener("hashchange", read);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", read);
    };
  }, [pathname]);

  if (HIDDEN.some((p) => pathname.startsWith(p))) return null;
  const tabs = TABS.filter((t) => approved || (t.key !== "earnings" && t.key !== "payouts"));

  const active = (t: (typeof TABS)[number]): boolean => {
    if (t.key === "documents") return pathname.startsWith("/delivery-partner/documents") || pathname.startsWith("/delivery-partner/kyc");
    if (t.key === "account") return pathname.startsWith("/profile");
    if (pathname !== "/delivery-partner") return false;
    if (t.key === "earnings") return hash === "#rider-earnings";
    if (t.key === "payouts") return hash === "#rider-payouts";
    return hash !== "#rider-earnings" && hash !== "#rider-payouts";
  };

  return (
    <>
      {/* Room at the end of the page so the bar never covers the last button. */}
      <div aria-hidden className="h-[calc(4rem+env(safe-area-inset-bottom))] lg:hidden" />
      <nav
        aria-label={tr(TEXT.tabs, lang)}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-300 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_10px_rgba(0,0,0,0.06)] lg:hidden"
        data-testid="rider-bottom-nav"
      >
        <ul className={clsx("mx-auto grid h-16 max-w-xl", tabs.length === 5 ? "grid-cols-5" : tabs.length === 4 ? "grid-cols-4" : "grid-cols-3")}>
          {tabs.map((t) => {
            const here = active(t);
            return (
              <li key={t.key} className="min-w-0">
                <Link
                  href={t.href}
                  aria-current={here ? "page" : undefined}
                  data-testid={`rider-tab-${t.key}`}
                  onClick={() => setHash(t.href.includes("#") ? t.href.slice(t.href.indexOf("#")) : "")}
                  className={clsx("flex h-16 flex-col items-center justify-center gap-0.5 text-xs font-semibold", here ? "text-kesari-800" : "text-ink-700")}
                >
                  <span className={clsx("grid h-8 w-12 place-items-center rounded-full", here && "bg-kesari-100")}>
                    <Icon name={t.icon} size={22} />
                  </span>
                  <span className="max-w-full truncate px-0.5">{tr(TEXT[t.key], lang)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
