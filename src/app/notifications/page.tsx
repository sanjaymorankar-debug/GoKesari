import Link from "next/link";
import { redirect } from "next/navigation";
import clsx from "clsx";

import { ListTabs, Pager } from "@/components/board/list-tabs";
import { MarkAllReadButton } from "@/components/notifications/mark-all-read-button";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { L, tr, UI } from "@/lib/board/i18n";
import { pickTab } from "@/lib/board/status-groups";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { listNotificationCentre } from "@/server/notifications/centre";

export const metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

const TABS = ["unread", "all"] as const;
const TEXT = {
  description: L(
    "Everything GoKesari told you: orders, deliveries, payments and announcements.",
    "GoKesari की सभी सूचनाएँ: ऑर्डर, डिलीवरी, भुगतान और घोषणाएँ।",
    "GoKesari च्या सर्व सूचना: ऑर्डर, डिलिव्हरी, पेमेंट आणि घोषणा.",
  ),
  unread: L("Unread", "अपठित", "न वाचलेल्या"),
  all: L("All", "सभी", "सर्व"),
  markAll: L("Mark all read", "सब पढ़ा हुआ करें", "सर्व वाचले म्हणून खूण करा"),
  settings: L("Notification settings", "सूचना सेटिंग्स", "सूचना सेटिंग्ज"),
  open: L("Open", "खोलें", "उघडा"),
  noneUnread: L("You're all caught up.", "कोई अपठित सूचना नहीं।", "न वाचलेली सूचना नाही."),
  none: L("No notifications yet.", "अभी कोई सूचना नहीं।", "अजून कोणतीही सूचना नाही."),
};

/**
 * The Notification Centre (F3.3.2): the person's notifications with read /
 * unread state, Unread / All tabs, paging, "Mark all read" and a link per
 * item (/notifications/<id> marks it read and opens where it points). Tile
 * Board list style; the same page in the app. Settings stay on
 * /profile?tab=notifications.
 */
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ tab?: string; page?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const query = await searchParams;
  const lang = await getBoardLang();
  const peek = await listNotificationCentre(user.id, { filter: "unread", pageSize: 1 });
  const tab = pickTab(query.tab, TABS, peek.unread > 0 ? "unread" : "all");
  const page = await listNotificationCentre(user.id, { filter: tab, page: Number(query.page) || 1, pageSize: 15 });

  return (
    <div className="mx-auto max-w-2xl" data-testid="notification-centre">
      <PageHeader
        title={tr(UI.notifications, lang)}
        description={tr(TEXT.description, lang)}
        action={<MarkAllReadButton label={tr(TEXT.markAll, lang)} disabled={page.unread === 0} />}
      />
      <ListTabs
        label={tr(UI.notifications, lang)}
        active={tab}
        tabs={[
          { key: "unread", label: tr(TEXT.unread, lang), href: "/notifications?tab=unread", count: page.unread, urgent: true },
          { key: "all", label: tr(TEXT.all, lang), href: "/notifications?tab=all" },
        ]}
      />
      {page.items.length === 0 ? (
        <EmptyState title={tr(tab === "unread" ? TEXT.noneUnread : TEXT.none, lang)} />
      ) : (
        <Card className="divide-y divide-[var(--gk-line)] overflow-hidden">
          {page.items.map((n) => (
            <a
              key={n.id}
              href={`/notifications/${n.id}`}
              className={clsx("flex min-h-16 gap-3 p-4 hover:bg-kesari-50", !n.read && "bg-kesari-50/60")}
              data-testid="notification-item"
              data-read={n.read ? "true" : "false"}
            >
              <span aria-hidden className={clsx("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", n.read ? "bg-cream-200" : "bg-kesari-700")} />
              <span className="min-w-0 flex-1">
                <span className={clsx("block text-base text-ink-900", !n.read && "font-bold")}>{n.title}</span>
                <span className="mt-0.5 block text-sm text-ink-700">{n.body}</span>
                <span className="mt-1 block text-xs text-ink-500">
                  {new Date(n.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}
                  {n.read ? "" : ` · ${tr(UI.unread, lang)}`}
                  {n.actionUrl ? ` · ${tr(TEXT.open, lang)} →` : ""}
                </span>
              </span>
              {n.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={n.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-xl object-cover" loading="lazy" />
              ) : null}
            </a>
          ))}
        </Card>
      )}
      <Pager lang={lang} page={page.page} pageCount={page.pageCount} hrefFor={(n) => `/notifications?tab=${tab}&page=${n}`} />
      <p className="mt-6 text-sm">
        <Link href="/profile?tab=notifications" className="font-semibold text-kesari-800 underline">
          {tr(TEXT.settings, lang)}
        </Link>
      </p>
    </div>
  );
}
