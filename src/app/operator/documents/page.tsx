import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listDocumentsToVerify } from "@/server/services/operator-limited";

export const metadata = { title: "Documents to verify" };
export const dynamic = "force-dynamic";

/** F8.4.2 — documents waiting for a decision, on this operator's own shops only. */
export default async function OperatorDocumentsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS)) redirect("/");
  const docs = await listDocumentsToVerify(user);
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4">
      <PageHeader title="Documents to verify" description="FSSAI, licences and other documents of the shops you onboarded." />
      {docs.length === 0 ? (
        <EmptyState title="Nothing to verify" />
      ) : (
        <ul className="space-y-2">
          {docs.map((d) => (
            <li key={d.verificationId}>
              <Link href={`/operator/shops/${d.shopId}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl border border-cream-200 bg-white p-3">
                <span>
                  <span className="block font-semibold text-ink-900">{d.label}</span>
                  <span className="block text-xs text-ink-500">{d.shopName} · {d.numberMasked ?? "—"}</span>
                </span>
                <Badge tone="warning">{d.status.replace(/_/g, " ")}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
