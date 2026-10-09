import Link from "next/link";

import { Icon } from "@/components/board/icons";
import { LANG_TAG, tr, UI } from "@/lib/board/i18n";
import { BOARD_HOME, boardRoleFor } from "@/lib/board/menus";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";

/** A link that leads nowhere: say so plainly and send the user back to their own board. */
export default async function NotFound() {
  const [lang, user] = await Promise.all([getBoardLang(), getCurrentUser().catch(() => null)]);
  const home = BOARD_HOME[boardRoleFor(user?.role)];
  return (
    <div lang={LANG_TAG[lang]} className="mx-auto flex max-w-md flex-col items-center gap-3 py-10 text-center" data-testid="not-found-state">
      <span className="grid h-14 w-14 place-items-center rounded-full bg-kesari-50 text-kesari-700">
        <Icon name="search" size={30} />
      </span>
      <h1 className="text-xl font-bold text-ink-900">{tr(UI.notFoundTitle, lang)}</h1>
      <p className="text-base text-ink-700">{tr(UI.notFoundText, lang)}</p>
      <Link href={home} className="mt-2 flex h-12 items-center gap-2 rounded-xl bg-kesari-700 px-5 text-base font-bold text-white hover:bg-kesari-800">
        <Icon name="layout-grid" size={18} />
        {tr(UI.backToBoard, lang)}
      </Link>
    </div>
  );
}
