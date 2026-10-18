import { redirect } from "next/navigation";

import { WsdTileBoard } from "@/components/batch-d/tile-board";
import { OPERATOR_LIMITED_MENUS } from "@/lib/board/batch-d-menus";
import { formatCount } from "@/lib/board/format";
import { L, tr } from "@/lib/board/i18n";
import { visibleMenus } from "@/lib/board/menus";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardHeaderData } from "@/server/board-header-data";
import { getBoardLang } from "@/server/board-lang";
import { operatorLimitedBoardCounts } from "@/server/services/operator-limited";

export const metadata = { title: "Operator" };
export const dynamic = "force-dynamic";

const ROLE_LINE = L("Operator (Limited)", "ऑपरेटर (सीमित)", "ऑपरेटर (मर्यादित)");
const TITLE = L("Shop onboarding", "दुकान ऑनबोर्डिंग", "दुकान नोंदणी");

/**
 * Operators and admins share one console (/admin); capability checks inside it
 * decide what renders, so they are sent there as before. The Operator-Limited
 * role (batch-2026-10 WS-D, F8.4.2) has its own Tile Board here: onboard a
 * shop, my shops, documents to verify, payment links.
 */
export default async function OperatorPage() {
  const user = await getCurrentUser();
  if (user?.role !== "OPERATOR_LIMITED") redirect("/admin");

  const [lang, header, counts] = await Promise.all([getBoardLang(), getBoardHeaderData(user), operatorLimitedBoardCounts(user)]);
  const menus = visibleMenus(OPERATOR_LIMITED_MENUS, user.role);
  const n = (v: number) => (v > 0 ? formatCount(v) : null);
  return (
    <WsdTileBoard
      board="operator-limited"
      lang={lang}
      user={user}
      header={header}
      roleLine={tr(ROLE_LINE, lang)}
      title={tr(TITLE, lang)}
      menus={menus}
      headlines={{
        onboard: n(counts.openOnboardings),
        myShops: n(counts.myShops),
        documents: n(counts.documentsToVerify),
        payments: n(counts.feesPending + counts.feesFailed),
      }}
    />
  );
}
