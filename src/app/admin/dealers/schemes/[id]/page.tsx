import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { SchemeBuilder } from "@/components/dealer/scheme-builder";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { isDealerStaff } from "@/server/dealers/staff-access";
import { schemePermissions } from "@/server/dealers/scheme-admin";
import { listSchemes } from "@/server/dealers/schemes";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Dealer scheme" };
export const dynamic = "force-dynamic";

/** docs/dealer-platform phase 4: one scheme — versions, compare, edit a draft, preview, simulate, publish. */
export default async function AdminDealerSchemePage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!isDealerStaff(user.role)) redirect("/");
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const scheme = (await listSchemes()).find((s) => s.id === id.data);
  if (!scheme) notFound();
  const perms = await schemePermissions({ id: user.id, role: user.role });
  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <Link href="/admin/dealers/schemes" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Schemes
      </Link>
      <PageHeader title={scheme.name} description={`${scheme.code} · ${scheme.category === "FRANCHISE" ? "franchise" : "dealership"} · ${scheme.activeDealers} dealers`} />
      <SchemeBuilder scheme={JSON.parse(JSON.stringify(scheme))} canEdit={perms.edit} />
    </div>
  );
}
