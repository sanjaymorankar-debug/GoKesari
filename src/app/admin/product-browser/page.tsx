import { redirect } from "next/navigation";

import { WsdTileBoard } from "@/components/batch-d/tile-board";
import { PRODUCT_BROWSER_MENUS } from "@/lib/board/batch-d-menus";
import { formatCount } from "@/lib/board/format";
import { L, tr } from "@/lib/board/i18n";
import { visibleMenus } from "@/lib/board/menus";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getBoardHeaderData } from "@/server/board-header-data";
import { getBoardLang } from "@/server/board-lang";
import { browserBoardCounts } from "@/server/pmd/browser";

export const metadata = { title: "Product browser" };
export const dynamic = "force-dynamic";

/** F9.1.4 — the product browser's Tile Board (admin / operator): browse, duplicates, imports, sources, manufacturers. */
export default async function ProductBrowserBoard() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PMD_VIEW)) redirect("/");
  const [lang, header, counts] = await Promise.all([getBoardLang(), getBoardHeaderData(user), browserBoardCounts()]);
  const n = (v: number | null) => (v && v > 0 ? formatCount(v) : null);
  return (
    <WsdTileBoard
      board="product-browser"
      lang={lang}
      user={user}
      header={header}
      roleLine={tr(user.role === "ADMIN" ? L("Admin", "एडमिन", "ॲडमिन") : L("Operator", "ऑपरेटर", "ऑपरेटर"), lang)}
      title={tr(L("Product browser", "प्रोडक्ट ब्राउज़र", "उत्पादन ब्राउझर"), lang)}
      menus={visibleMenus(PRODUCT_BROWSER_MENUS, user.role)}
      headlines={{
        browse: counts.staging != null && counts.master != null ? `${formatCount(counts.staging) ?? 0} / ${formatCount(counts.master) ?? 0}` : null,
        duplicates: n(counts.duplicates),
        jobs: n(counts.activeJobs),
        manufacturers: n(counts.manufacturers),
      }}
    />
  );
}
