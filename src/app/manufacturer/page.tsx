import { redirect } from "next/navigation";

import { WsdTileBoard } from "@/components/batch-d/tile-board";
import { EmptyState } from "@/components/ui";
import { MANUFACTURER_MENUS } from "@/lib/board/batch-d-menus";
import { formatCount } from "@/lib/board/format";
import { L, tr } from "@/lib/board/i18n";
import { visibleMenus } from "@/lib/board/menus";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardHeaderData } from "@/server/board-header-data";
import { getBoardLang } from "@/server/board-lang";
import { listJobs } from "@/server/pmd/ingest-jobs";
import { listApiKeys, manufacturerAccountsForUser } from "@/server/pmd/manufacturers";

export const metadata = { title: "Manufacturer portal" };
export const dynamic = "force-dynamic";

/** F9.1.2 — the manufacturer self-upload portal (Tile Board). Access = membership of a manufacturer account. */
export default async function ManufacturerHome() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const [account] = await manufacturerAccountsForUser(user.id);
  if (!account) {
    return (
      <div className="mx-auto max-w-xl px-3 py-8">
        <EmptyState title="No manufacturer account" description="Ask GoKesari to link your sign-in to your company's manufacturer account." />
      </div>
    );
  }
  const [lang, header, jobs, keys] = await Promise.all([getBoardLang(), getBoardHeaderData(user), listJobs({ manufacturerAccountId: account.id, limit: 50 }), listApiKeys(account.id)]);
  const running = jobs.filter((j) => j.status === "QUEUED" || j.status === "RUNNING").length;
  return (
    <WsdTileBoard
      board="manufacturer"
      lang={lang}
      user={user}
      header={header}
      roleLine={tr(L("Manufacturer", "निर्माता", "उत्पादक"), lang)}
      title={account.name}
      menus={visibleMenus(MANUFACTURER_MENUS, user.role)}
      headlines={{
        jobs: running > 0 ? `${formatCount(running)} running` : formatCount(jobs.length),
        keys: formatCount(keys.filter((k) => !k.revokedAt).length),
      }}
    />
  );
}
