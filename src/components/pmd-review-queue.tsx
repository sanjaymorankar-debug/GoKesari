"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";

export interface PmdReviewRow {
  candidateId: number;
  matchScore: number;
  matchStatus: string;
  relation: string;
  rule: string | null;
  hardConflicts: string[];
  incoming: { source: string; name: string | null; brand: string | null };
  candidate: { masterProductId: string; name: string; brand: string | null; packSize: string | null };
}

type Decision = "CONFIRMED_SAME" | "CONFIRMED_DIFFERENT" | "SAME_FAMILY";

/**
 * The possible-duplicate queue. The matcher never merges below its threshold; a person decides here.
 * "Same product" merges by pointer (nothing is deleted); "Different" closes the item; "Same family"
 * groups pack sizes / variants of one line.
 */
export function PmdReviewQueue({ rows, canDecide }: { rows: PmdReviewRow[]; canDecide: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (rows.length === 0) {
    return <EmptyState title="No possible duplicates waiting." description="Records the matcher was unsure about appear here instead of being merged automatically." />;
  }

  async function decide(id: number, decision: Decision) {
    setBusy(id);
    setError(null);
    const res = await fetch(`/api/product-master/review/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    setBusy(null);
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not save the decision.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card className="divide-y divide-cream-200">
        {rows.map((r) => (
          <div key={r.candidateId} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1 text-sm">
                <p className="text-ink-900">
                  <span className="text-xs uppercase tracking-wide text-ink-500">Incoming · {r.incoming.source}</span>
                  <br />
                  <span className="font-medium">{r.incoming.name ?? "(no name)"}</span>
                  {r.incoming.brand ? <span className="text-ink-500"> — {r.incoming.brand}</span> : null}
                </p>
                <p className="text-ink-900">
                  <span className="text-xs uppercase tracking-wide text-ink-500">Existing · {r.candidate.masterProductId}</span>
                  <br />
                  <span className="font-medium">{r.candidate.name}</span>
                  {r.candidate.brand ? <span className="text-ink-500"> — {r.candidate.brand}</span> : null}
                  {r.candidate.packSize ? <span className="text-ink-500"> · {r.candidate.packSize}</span> : null}
                </p>
                <p className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                  <Badge>{r.matchStatus.replace("_", " ").toLowerCase()}</Badge>
                  <span>score {r.matchScore.toFixed(1)}</span>
                  {r.rule ? <span>· {r.rule}</span> : null}
                  {r.hardConflicts.length ? <span className="text-kesari-700">· conflicts: {r.hardConflicts.join(", ")}</span> : null}
                </p>
              </div>
              {canDecide ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy === r.candidateId} onClick={() => decide(r.candidateId, "CONFIRMED_SAME")}>
                    Same product
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === r.candidateId} onClick={() => decide(r.candidateId, "SAME_FAMILY")}>
                    Same family
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === r.candidateId} onClick={() => decide(r.candidateId, "CONFIRMED_DIFFERENT")}>
                    Different
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
