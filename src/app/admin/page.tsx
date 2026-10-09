import { redirect } from "next/navigation";

import { HashRedirect } from "@/components/board/hash-redirect";
import { StaffBoard } from "@/components/board/staff-board";
import { getCurrentUser } from "@/server/authz/guards";
import { loadStaffBoard } from "@/server/board-data";
import { getBoardHeaderData } from "@/server/board-header-data";
import { getBoardLang } from "@/server/board-lang";

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

/** Links into the old one-page console (`/admin#users`) → the section's own page. */
const OLD_SECTIONS: Record<string, string> = {
  "shop-approvals": "/admin/console/shops",
  "approved-shops": "/admin/console/shops#approved-shops",
  "product-approvals": "/admin/console/product-approvals",
  users: "/admin/console/users",
  "delivery-partners": "/admin/console/riders",
  grievances: "/admin/console/grievances",
  vouchers: "/admin/console/vouchers",
  "voucher-upload": "/admin/console/vouchers#voucher-upload",
  "audit-log": "/admin/console/audit-log",
  "shop-finance": "/admin/console/registration-fees",
};

/**
 * Admin and operator home (§42, §43): the Tile Board — one screen holding
 * every menu with live counts. The sections of the old one-page console now
 * each have their own page under /admin/console, opened from the board.
 */
export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");

  const [lang, header, board] = await Promise.all([getBoardLang(), getBoardHeaderData(user), loadStaffBoard(user.role)]);

  return (
    <>
      <HashRedirect map={OLD_SECTIONS} />
      <StaffBoard lang={lang} user={user} header={header} data={board} />
    </>
  );
}
