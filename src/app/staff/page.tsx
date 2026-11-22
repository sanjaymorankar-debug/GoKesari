import { redirect } from "next/navigation";

import { WsdTileBoard } from "@/components/batch-d/tile-board";
import { L, tr, type Text } from "@/lib/board/i18n";
import { visibleMenus } from "@/lib/board/menus";
import { STAFF_MENUS } from "@/lib/board/rbac-menus";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getBoardHeaderData } from "@/server/board-header-data";
import { getBoardLang } from "@/server/board-lang";
import type { UserRole } from "@/server/db/schema";
import { getFeatureFlags, flagCoversRole } from "@/server/services/feature-flags";

export const metadata = { title: "Staff board" };
export const dynamic = "force-dynamic";

const ROLE_LINES: Partial<Record<UserRole, Text>> = {
  CA: L("Chartered Accountant", "चार्टर्ड अकाउंटेंट", "चार्टर्ड अकाउंटंट"),
  ACCOUNTANT: L("Accountant", "लेखाकार", "लेखापाल"),
  SUPPORT_MANAGER: L("Support Manager", "सहायता प्रबंधक", "सहाय्य व्यवस्थापक"),
  SUPPORT_USER: L("Support", "सहायता", "सहाय्य"),
  OPERATIONS_MANAGER: L("Operations Manager", "ऑपरेशंस प्रबंधक", "ऑपरेशन्स व्यवस्थापक"),
  OPERATIONS_USER: L("Operations", "ऑपरेशंस", "ऑपरेशन्स"),
};
const TITLE = L("My work", "मेरा काम", "माझे काम");

/**
 * RBAC v2 staff board (docs/rbac): one Tile Board, one screen, for the six staff roles. Each role
 * sees only the tiles its permissions open; tiles of an area whose rbac_v2_* flag is off (for this
 * role) stay hidden. Admins and operators keep /admin.
 */
export default async function StaffBoardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role === "ADMIN" || user.role === "OPERATOR") redirect("/admin");
  if (!can(user.role, PERMISSIONS.STAFF_BOARD)) redirect("/");

  const [lang, header, flags] = await Promise.all([getBoardLang(), getBoardHeaderData(user), getFeatureFlags()]);
  const features = Object.values(flags)
    .filter((f) => flagCoversRole(f, user.role))
    .map((f) => f.key);
  const menus = visibleMenus(STAFF_MENUS, user.role, { features });
  return (
    <WsdTileBoard
      board="staff"
      lang={lang}
      user={user}
      header={header}
      roleLine={tr(ROLE_LINES[user.role] ?? L("Staff", "स्टाफ", "कर्मचारी"), lang)}
      title={tr(TITLE, lang)}
      menus={menus}
      headlines={{}}
    />
  );
}
