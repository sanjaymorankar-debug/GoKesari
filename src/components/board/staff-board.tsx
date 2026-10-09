import clsx from "clsx";

import { formatCount } from "@/lib/board/format";
import { L, LANG_TAG, tr, UI, type Lang } from "@/lib/board/i18n";
import { ADMIN_DO_NOW, ADMIN_MENUS, OPERATOR_DO_NOW, OPERATOR_MENUS, visibleItems, visibleMenus } from "@/lib/board/menus";
import type { UserRole } from "@/server/db/schema";
import type { BoardHeaderData } from "@/server/board-header-data";
import type { StaffBoardData } from "@/server/board-data";

import { BoardHeader } from "./board-header";
import { Banner, DoNowStrip, Tile } from "./tiles";

interface Props {
  lang: Lang;
  user: { name: string | null; email: string; role: UserRole };
  header: BoardHeaderData;
  data: StaffBoardData;
}

const MINUTES = L("min", "मिनट", "मिनिटे");
const LATEST = L("Latest", "नवीनतम", "नवीनतम");
const REVIEW_NOW = L("Disputes waiting for an administrator", "एडमिन के लिए विवाद", "ॲडमिनसाठी थांबलेले वाद");

/**
 * Admin and operator home board (`/admin`): the "Do now" strip, then the
 * tiles — admin nine (3×3), operator seven (2 columns on phones, 4 on wide
 * screens). On wide screens the operator also sees the two alert banners
 * (oldest late order, latest escalated ticket) when there is something to
 * act on; on phones the "Do now" counts carry the same news.
 */
export function StaffBoard({ lang, user, header, data }: Props) {
  const isAdmin = user.role === "ADMIN";
  const board = isAdmin ? "admin" : "operator";
  const menus = visibleMenus(isAdmin ? ADMIN_MENUS : OPERATOR_MENUS, user.role, {}, board);
  const doNow = visibleItems(isAdmin ? ADMIN_DO_NOW : OPERATOR_DO_NOW, user.role);
  const { attention, escalated } = data.alerts;

  return (
    <div data-tile-board={board} lang={LANG_TAG[lang]} className="flex min-h-[100svh] flex-col bg-[var(--gk-bg)] text-ink-900 max-lg:h-[100svh]">
      <BoardHeader
        lang={lang}
        user={user}
        roles={header.roles}
        unreadCount={header.unread}
        extraLinks={header.extraLinks}
        context={{
          kind: "staff",
          roleLine: tr(isAdmin ? UI.admin : UI.operator, lang),
          title: tr(isAdmin ? UI.adminConsole : UI.operatorConsole, lang),
        }}
      />
      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-2 px-2 py-2 sm:px-3 lg:gap-4 lg:px-6 lg:py-4">
        <DoNowStrip items={doNow} lang={lang} counts={data.counts} />

        {!isAdmin && ((attention?.total ?? 0) > 0 || (escalated?.total ?? 0) > 0) ? (
          <div className="hidden gap-3 max-lg:hidden lg:grid lg:grid-cols-2">
            {attention && attention.total > 0 ? (
              <Banner
                testId="alert-orders"
                icon="timer"
                iconClass="bg-red-700"
                title={`${formatCount(attention.total)} ${tr(UI.ordersNeedAttention, lang)}`}
                detail={
                  attention.oldestOrderNumber
                    ? `${tr(UI.oldest, lang)} ${attention.oldestOrderNumber}${attention.oldestMinutes != null ? ` · ${attention.oldestMinutes} ${tr(MINUTES, lang)}` : ""}`
                    : null
                }
                action={tr(UI.fix, lang)}
                href="/admin/exceptions"
              />
            ) : null}
            {escalated && escalated.total > 0 ? (
              <Banner
                testId="alert-escalated"
                icon="life-buoy"
                iconClass="bg-red-700"
                title={`${formatCount(escalated.total)} ${tr(UI.escalatedTickets, lang)}`}
                detail={escalated.latestCase ? `${tr(LATEST, lang)} ${escalated.latestCase}` : tr(REVIEW_NOW, lang)}
                action={tr(UI.open, lang)}
                href="/admin/disputes?status=ESCALATED"
              />
            ) : null}
          </div>
        ) : null}

        <nav aria-label={tr(UI.board, lang)} className="flex min-h-0 flex-1 flex-col">
          <div
            className={clsx(
              "grid min-h-0 flex-1 gap-1.5 [grid-auto-rows:minmax(0,1fr)] lg:gap-4",
              isAdmin ? "grid-cols-3" : "grid-cols-2 lg:grid-cols-4",
            )}
          >
            {menus.map((menu) => (
              <Tile key={menu.key} menu={menu} lang={lang} counts={data.counts} compact={!isAdmin} chipIcons={!isAdmin} tagCounts={isAdmin ? "urgent" : "all"} />
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}
