import { notFound, redirect } from "next/navigation";

import { DocumentDecision } from "@/components/batch-d/document-decision";
import { Badge, PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getShopDocumentsForOperator } from "@/server/services/operator-limited";

export const metadata = { title: "Shop documents" };
export const dynamic = "force-dynamic";

const DECIDABLE = new Set(["PENDING", "MANUAL_REVIEW"]);

/** F8.4.2 — one own shop's documents (by shop type), viewed online and approved / rejected with a reason. */
export default async function OperatorShopPage({ params }: { params: Promise<{ shopId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS)) redirect("/");
  const { shopId } = await params;
  let data: Awaited<ReturnType<typeof getShopDocumentsForOperator>>;
  try {
    data = await getShopDocumentsForOperator(shopId, user);
  } catch (error) {
    if (error instanceof AppError && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")) notFound();
    throw error;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4">
      <PageHeader title={data.shop.name} description={`Documents for a ${data.shop.shopType.replace(/_/g, " ").toLowerCase()} shop · ${data.shop.status.replace(/_/g, " ")}`} />
      <ul className="space-y-2">
        {data.documents
          .filter((d) => d.requirement !== "optional" || d.status !== "NOT_SUBMITTED")
          .map((d) => (
            <li key={d.docType} className="rounded-xl border border-cream-200 bg-white p-3" data-testid={`doc-${d.docType}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-ink-900">{d.label}</p>
                <span className="flex gap-1">
                  <Badge tone={d.requirement === "optional" ? "neutral" : "info"}>{d.requirement === "optional" ? "optional" : "required"}</Badge>
                  <Badge tone={d.status === "VERIFIED" ? "success" : d.status === "FAILED" ? "danger" : "warning"}>{d.status.replace(/_/g, " ")}</Badge>
                </span>
              </div>
              <p className="text-xs text-ink-500">
                {d.numberMasked ?? "No number submitted"}
                {d.reviewNote ? ` · ${d.reviewNote}` : ""}
              </p>
              {d.files.length ? (
                <p className="mt-1 flex flex-wrap gap-2 text-sm">
                  {d.files.map((f, i) => (
                    <a key={f.id} className="font-semibold text-kesari-800 underline" href={`/api/operator/files/${f.id}`} target="_blank" rel="noopener">
                      View file {i + 1}
                    </a>
                  ))}
                </p>
              ) : null}
              {d.id && DECIDABLE.has(d.status) ? <DocumentDecision verificationId={d.id} /> : null}
            </li>
          ))}
      </ul>
    </div>
  );
}
