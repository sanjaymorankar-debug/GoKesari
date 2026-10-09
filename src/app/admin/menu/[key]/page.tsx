import { notFound, redirect } from "next/navigation";

import { MenuHub } from "@/components/board/menu-hub";
import { ADMIN_MENUS, OPERATOR_MENUS, visibleMenus } from "@/lib/board/menus";
import { getCurrentUser } from "@/server/authz/guards";
import { loadStaffBoard } from "@/server/board-data";
import { getBoardLang } from "@/server/board-lang";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const menu = [...ADMIN_MENUS, ...OPERATOR_MENUS].find((m) => m.key === key);
  return { title: menu ? menu.label.en : "Menu" };
}

/**
 * An admin or operator tile's menu page: every function of that area, with
 * live counts — only those the role may open (each page checks again).
 */
export default async function AdminMenuPage({ params }: { params: Promise<{ key: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  const { key } = await params;

  const board = user.role === "ADMIN" ? "admin" : "operator";
  const menu = visibleMenus(board === "admin" ? ADMIN_MENUS : OPERATOR_MENUS, user.role, {}, board).find((m) => m.key === key);
  if (!menu) notFound();

  const [lang, data] = await Promise.all([getBoardLang(), loadStaffBoard(user.role)]);
  return <MenuHub lang={lang} menu={menu} counts={data.counts} boardHref="/admin" />;
}
