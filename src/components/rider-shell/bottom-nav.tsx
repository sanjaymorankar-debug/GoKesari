"use client";

/**
 * Rider App v2 (rule riderAppV2): the fixed bottom bar —
 * Home · Earnings · My Slots · Refer · More — on every rider page. Hidden on
 * the full-screen navigation map, which has its own controls.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

import { Icon, type IconName } from "@/components/board/icons";
import { L, LANG_TAG, tr, type Lang } from "@/lib/board/i18n";

const T = {
  nav: L("Rider menu", "राइडर मेनू", "रायडर मेनू"),
  home: L("Home", "होम", "होम"),
  earnings: L("Earnings", "कमाई", "कमाई"),
  slots: L("My Slots", "मेरे स्लॉट", "माझे स्लॉट"),
  refer: L("Refer", "रेफ़र", "रेफर"),
  more: L("More", "और", "अधिक"),
} as const;

const HOME = "/delivery-partner";

/** Pages under /delivery-partner without the bar (their own full-screen controls). */
export function showsRiderNav(pathname: string): boolean {
  return !pathname.startsWith("/delivery-partner/navigate");
}

export function RiderBottomNav({ lang }: { lang: Lang }) {
  const pathname = usePathname() ?? HOME;
  if (!showsRiderNav(pathname)) return null;
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  const items: { key: string; href: string; label: string; icon: IconName; active: boolean }[] = [
    { key: "home", href: HOME, label: tr(T.home, lang), icon: "house", active: pathname === HOME },
    { key: "earnings", href: `${HOME}/earnings`, label: tr(T.earnings, lang), icon: "indian-rupee", active: under(`${HOME}/earnings`) },
    { key: "slots", href: `${HOME}/slots`, label: tr(T.slots, lang), icon: "calendar-clock", active: under(`${HOME}/slots`) },
    { key: "refer", href: `${HOME}/refer`, label: tr(T.refer, lang), icon: "gift", active: under(`${HOME}/refer`) },
    { key: "more", href: `${HOME}/more`, label: tr(T.more, lang), icon: "menu", active: under(`${HOME}/more`) },
  ];
  return (
    <>
      {/* Keeps the page's last lines clear of the fixed bar. */}
      <div aria-hidden className="h-[calc(4.5rem+env(safe-area-inset-bottom))]" />
      <nav
        lang={LANG_TAG[lang]}
        aria-label={tr(T.nav, lang)}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-cream-200 bg-white pb-[env(safe-area-inset-bottom)]"
        data-testid="rider-bottom-nav"
      >
        <ul className="mx-auto grid h-16 max-w-xl grid-cols-5">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                data-key={item.key}
                className={clsx(
                  "flex h-full flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-semibold leading-tight",
                  item.active ? "text-kesari-800" : "text-ink-600 hover:text-ink-900",
                )}
              >
                <span className={clsx("grid h-7 w-12 place-items-center rounded-full", item.active && "bg-kesari-100")}>
                  <Icon name={item.icon} size={20} />
                </span>
                <span className="max-w-full truncate px-0.5">{item.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
