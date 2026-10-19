import Link from "next/link";
import { redirect } from "next/navigation";

import { CannedRepliesManager } from "@/components/aftercare/canned-replies-manager";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listCannedReplies } from "@/server/aftercare/support-tickets";

export const metadata = { title: "Canned replies" };
export const dynamic = "force-dynamic";

/** Admin keeps the help desk's ready-made replies (F6.3.3, batch-2026-10 WS-C). */
export default async function CannedRepliesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SUPPORT_CANNED_REPLY_MANAGE)) redirect("/admin/support");
  const rows = await listCannedReplies(user, { includeInactive: true });
  return (
    <>
      <PageHeader title="Canned replies" description={<Link href="/admin/support" className="underline">← Help desk</Link>} />
      <CannedRepliesManager rows={rows.map((r) => ({ id: r.id, title: r.title, body: r.body, category: r.category, active: r.active }))} />
    </>
  );
}
