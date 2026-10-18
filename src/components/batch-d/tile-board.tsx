import type { Lang } from "@/lib/board/i18n";
import type { ResolvedMenu } from "@/lib/board/menus";
import type { UserRole } from "@/server/db/schema";
import type { BoardHeaderData } from "@/server/board-header-data";

import { BoardHeader } from "@/components/board/board-header";
import { Tile } from "@/components/board/tiles";

/**
 * A small Tile Board (Theme 1) for the batch-2026-10 WS-D areas: the
 * Operator-Limited home (/operator), the manufacturer portal (/manufacturer)
 * and the product browser (/admin/product-browser). The same header and tiles
 * as the role boards; each tile shows a live figure as its headline. Touch
 * screens get one large link per tile (no hover-only controls).
 */
export function WsdTileBoard({
  board,
  lang,
  user,
  header,
  roleLine,
  title,
  menus,
  headlines,
  children,
}: {
  board: string;
  lang: Lang;
  user: { name: string | null; email: string; role: UserRole };
  header: BoardHeaderData;
  roleLine: string;
  title: string;
  menus: ResolvedMenu[];
  headlines: Record<string, string | null>;
  children?: React.ReactNode;
}) {
  return (
    <div data-tile-board={board} className="flex min-h-[100svh] flex-col bg-[var(--gk-bg)] text-ink-900">
      <BoardHeader
        lang={lang}
        user={user}
        roles={header.roles}
        unreadCount={header.unread}
        extraLinks={header.extraLinks}
        context={{ kind: "staff", roleLine, title }}
      />
      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-3 px-2 py-2 sm:px-3 lg:gap-4 lg:px-6 lg:py-4">
        <nav aria-label={title} className="flex flex-col">
          <div className="grid grid-cols-2 gap-1.5 [grid-auto-rows:minmax(7rem,auto)] lg:grid-cols-4 lg:gap-4">
            {menus.map((menu) => (
              <Tile key={menu.key} menu={menu} lang={lang} counts={{}} headline={headlines[menu.key] ?? null} compact chipIcons />
            ))}
          </div>
        </nav>
        {children}
      </div>
    </div>
  );
}
