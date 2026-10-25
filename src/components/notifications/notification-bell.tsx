"use client";

/**
 * The bell with its unread count and the Notification Centre panel (F3.3.2):
 * the latest notifications with read / unread state, "Mark all read", and
 * links to the full list (/notifications) and the settings
 * (/profile?tab=notifications). Without JavaScript the bell is a plain link to
 * /notifications. Works by tap (no hover-only controls), on the website and in
 * the app. In the app it also registers the phone for push once per session.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";

import { Icon } from "@/components/board/icons";
import { formatCount } from "@/lib/board/format";
import { L, tr, UI, type Lang } from "@/lib/board/i18n";
import { registerAppPushToken } from "@/lib/mobile-bridge-push";

interface Item {
  id: string;
  title: string;
  body: string;
  actionUrl: string | null;
  imageUrl: string | null;
  read: boolean;
  createdAt: string;
}

const TEXT = {
  markAll: L("Mark all read", "सब पढ़ा हुआ करें", "सर्व वाचले म्हणून खूण करा"),
  seeAll: L("See all", "सभी देखें", "सर्व पहा"),
  settings: L("Settings", "सेटिंग्स", "सेटिंग्ज"),
  empty: L("No notifications yet.", "अभी कोई सूचना नहीं।", "अजून कोणतीही सूचना नाही."),
  failed: L("Could not load notifications.", "सूचनाएँ लोड नहीं हो सकीं।", "सूचना लोड होऊ शकल्या नाहीत."),
  loading: L("Loading…", "लोड हो रहा है…", "लोड होत आहे…"),
};

function when(iso: string, lang: Lang): string {
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return lang === "en" ? "now" : date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h`;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

export function NotificationBell({
  lang,
  unreadCount,
  accountKey,
  testId,
  className,
  wrapperClassName = "relative",
  badgeClassName = "right-0.5",
}: {
  lang: Lang;
  unreadCount: number;
  /** The signed-in person (push registration is once per person per app session). */
  accountKey: string;
  testId: string;
  className: string;
  /** Classes of the element around the bell (e.g. hidden on the narrowest phones). */
  wrapperClassName?: string;
  badgeClassName?: string;
}) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(unreadCount);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  // A new server render brings a fresh count; navigation closes the panel.
  const [seen, setSeen] = useState({ unreadCount, pathname });
  if (seen.unreadCount !== unreadCount || seen.pathname !== pathname) {
    setSeen({ unreadCount, pathname });
    setUnread(unreadCount);
    setOpen(false);
  }

  useEffect(() => {
    void registerAppPushToken(accountKey).catch(() => {});
  }, [accountKey]);

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/notifications/centre?pageSize=8", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { items: Item[]; unread: number };
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      setError(true);
    }
  }, []);

  async function markAll() {
    setBusy(true);
    try {
      const res = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      if (res.ok) {
        setUnread(0);
        setItems((current) => current?.map((i) => ({ ...i, read: true })) ?? current);
      }
    } finally {
      setBusy(false);
    }
  }

  const count = formatCount(unread);
  const label = `${tr(UI.notifications, lang)}${count ? `, ${unread} ${tr(UI.unread, lang)}` : ""}`;

  return (
    <div ref={ref} className={wrapperClassName}>
      <Link
        href="/notifications"
        className={className}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          setOpen((v) => !v);
          if (!open) void load();
        }}
      >
        <Icon name="bell" size={22} />
        {count ? (
          <span
            className={clsx(
              "absolute top-0.5 grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-red-700 px-1 text-xs font-bold text-white ring-2 ring-white",
              badgeClassName,
            )}
          >
            {count}
          </span>
        ) : null}
      </Link>

      {open ? (
        <div
          role="dialog"
          aria-label={tr(UI.notifications, lang)}
          data-testid="notification-panel"
          className="fixed inset-x-2 top-16 z-50 max-h-[75vh] overflow-hidden rounded-2xl border border-[var(--gk-line)] bg-white shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--gk-line)] px-4 py-2">
            <p className="text-base font-bold text-ink-900">{tr(UI.notifications, lang)}</p>
            <button
              type="button"
              onClick={markAll}
              disabled={busy || unread === 0}
              className="min-h-11 rounded-lg px-2 text-sm font-semibold text-kesari-800 hover:bg-kesari-50 disabled:text-ink-500"
              data-testid="notification-mark-all"
            >
              {tr(TEXT.markAll, lang)}
            </button>
          </div>
          <ul className="max-h-[55vh] divide-y divide-[var(--gk-line)] overflow-y-auto">
            {error ? <li className="p-4 text-sm text-red-800">{tr(TEXT.failed, lang)}</li> : null}
            {!error && items === null ? <li className="p-4 text-sm text-ink-600">{tr(TEXT.loading, lang)}</li> : null}
            {!error && items?.length === 0 ? <li className="p-4 text-sm text-ink-600">{tr(TEXT.empty, lang)}</li> : null}
            {items?.map((item) => (
              <li key={item.id}>
                <a
                  href={`/notifications/${item.id}`}
                  className={clsx("flex gap-3 px-4 py-3 hover:bg-kesari-50", !item.read && "bg-kesari-50/60")}
                  data-read={item.read ? "true" : "false"}
                >
                  <span
                    aria-hidden
                    className={clsx("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", item.read ? "bg-transparent" : "bg-kesari-700")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className={clsx("block text-sm text-ink-900", !item.read && "font-bold")}>{item.title}</span>
                    <span className="line-clamp-2 block text-sm text-ink-600">{item.body}</span>
                    <span className="mt-0.5 block text-xs text-ink-500">
                      {when(item.createdAt, lang)}
                      {item.read ? "" : ` · ${tr(UI.unread, lang)}`}
                    </span>
                  </span>
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" loading="lazy" />
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2 border-t border-[var(--gk-line)] px-4 py-2">
            <Link href="/notifications" className="flex min-h-11 items-center text-sm font-bold text-kesari-800" data-testid="notification-see-all">
              {tr(TEXT.seeAll, lang)}
            </Link>
            <Link href="/profile?tab=notifications" className="flex min-h-11 items-center text-sm text-ink-700">
              {tr(TEXT.settings, lang)}
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
