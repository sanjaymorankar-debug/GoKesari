import { formatCount } from "@/lib/board/format";
import { L, LANG_TAG, tr, UI, type Lang } from "@/lib/board/i18n";
import { ADMIN_DO_NOW, ADMIN_MENUS, OPERATOR_MENUS, visibleItems, visibleMenus } from "@/lib/board/menus";
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
 * Admin and operator home board (`/admin`). Admin: the "Do now" strip and
 * nine tiles (3×3). Operator: two alert banners — shown only when there is
 * something to act on — and six tiles (2×3 on phones, 3×2 on wide screens).
 */
export function StaffBoard({ lang, user, header, data }: Props) {
  const isAdmin = user.role === "ADMIN";
  const menus = visibleMenus(isAdmin ? ADMIN_MENUS : OPERATOR_MENUS, user.role);
  const doNow = isAdmin ? visibleItems(ADMIN_DO_NOW, user.role) : [];
  const { attention, escalated } = data.alerts;

  return (
    <div data-tile-board={isAdmin ? "admin" : "operator"} lang={LANG_TAG[lang]} className="flex min-h-[100svh] flex-col bg-[#fdf4ea] text-ink-900">
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
      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-2 px-2 py-2 sm:px-3 lg:gap-4 lg:px-6 lg:py-4">
        {isAdmin ? <DoNowStrip items={doNow} lang={lang} counts={data.counts} /> : null}

        {!isAdmin && ((attention?.total ?? 0) > 0 || (escalated?.total ?? 0) > 0) ? (
          <div className="grid gap-1.5 lg:grid-cols-2 lg:gap-3">
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

        <div
          className={
            isAdmin
              ? "grid flex-1 grid-cols-3 gap-1 [--chip-gap-x:0.1875rem] [--chip-gap:0.1875rem] [--chip-h:1.625rem] [--chip-px:0.25rem] [--chip-text:0.78125rem] [--tile-pad:0.25rem] [--tile-title:0.8125rem] lg:gap-4"
              : "grid flex-1 grid-cols-2 gap-1.5 [--chip-gap:0.25rem] [--chip-h:1.875rem] [--chip-text:0.875rem] [--tile-pad:0.375rem] lg:grid-cols-3 lg:gap-4"
          }
        >
          {menus.map((menu) => (
            <Tile key={menu.key} menu={menu} lang={lang} counts={data.counts} />
          ))}
        </div>
      </div>
    </div>
  );
}
