import { redirect } from "next/navigation";

import { MergePair } from "@/components/batch-d/merge-pair";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { compareProducts, listDuplicatePairs } from "@/server/pmd/browser";

export const metadata = { title: "Duplicates" };
export const dynamic = "force-dynamic";

const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** F9.1.4 — possible duplicates found by the match engine (or two picked records), side by side, with merge. */
export default async function DuplicatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PMD_REVIEW)) redirect("/");
  const p = await searchParams;
  let picked: { left: Record<string, unknown>; right: Record<string, unknown> } | null = null;
  let pickError: string | null = null;
  if (typeof p.a === "string" && typeof p.b === "string") {
    try {
      picked = await compareProducts(p.a, p.b);
    } catch (error) {
      pickError = error instanceof AppError ? error.message : "Could not load the two products.";
    }
  }
  const pairs = await listDuplicatePairs(30);
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-3 py-4">
      <PageHeader title="Duplicates" description="Differences are highlighted. The record you keep takes the other's sources, offers, history and identifiers; the other is retired by pointer, never deleted." />
      {pickError ? <Alert tone="danger">{pickError}</Alert> : null}
      {picked ? <MergePair left={plain(picked.left)} right={plain(picked.right)} meta="Your selection" /> : null}
      {pairs.length === 0 && !picked ? <EmptyState title="No possible duplicates waiting" /> : null}
      {pairs.map((pair) => (
        <MergePair
          key={pair.candidateId}
          left={plain(pair.left)}
          right={plain(pair.right)}
          meta={`Match ${pair.score} · ${pair.status.replace(/_/g, " ").toLowerCase()} · ${pair.relation.replace(/_/g, " ").toLowerCase()}${pair.hardConflicts.length ? ` · conflicts: ${pair.hardConflicts.join(", ")}` : ""}`}
        />
      ))}
    </div>
  );
}
