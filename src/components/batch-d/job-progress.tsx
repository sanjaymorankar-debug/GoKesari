"use client";

/**
 * Import progress (batch-2026-10 WS-D, F9.1.4): polls GET /api/pmd/jobs/{id}
 * every few seconds while the import runs; validation report and the error
 * file link below.
 */
import { useEffect, useState } from "react";

import { Alert, Badge, Button } from "@/components/ui";

interface Progress {
  id: string;
  status: string;
  fileName: string | null;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  processedRows: number;
  stagedRows: number;
  failedRows: number;
  imagesStored: number;
  imagesFailed: number;
  batchesDone: number;
  percent: number;
  lastError: string | null;
  errorsByCode?: Record<string, number>;
}

const RUNNING = new Set(["QUEUED", "RUNNING"]);

export function JobProgressView({ initial, canResume }: { initial: Progress; canResume?: boolean }) {
  const [job, setJob] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!RUNNING.has(job.status)) return;
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/pmd/jobs/${job.id}`, { cache: "no-store" });
      if (res.ok) setJob(await res.json());
    }, 3000);
    return () => clearTimeout(timer);
  }, [job]);

  async function resume() {
    setError(null);
    const res = await fetch(`/api/pmd/jobs/${job.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume" }) });
    const data = await res.json().catch(() => null);
    if (!res.ok) setError(data?.error?.message ?? "Could not resume.");
    else setJob({ ...job, ...data });
  }

  const refused = job.invalidRows + job.failedRows;
  return (
    <div className="space-y-3 rounded-xl border border-cream-200 bg-white p-4" data-testid="job-progress">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-ink-900">{job.fileName ?? "Import"}</p>
        <Badge tone={job.status === "SUCCEEDED" ? "success" : job.status === "FAILED" ? "danger" : job.status === "PARTIAL" ? "warning" : "info"}>{job.status}</Badge>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-cream-100" role="progressbar" aria-valuenow={job.percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-kesari-600 transition-all" style={{ width: `${job.percent}%` }} />
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-ink-500">Rows</dt><dd>{job.totalRows.toLocaleString("en-IN")}</dd></div>
        <div><dt className="text-xs text-ink-500">Staged</dt><dd>{job.stagedRows.toLocaleString("en-IN")}</dd></div>
        <div><dt className="text-xs text-ink-500">Need attention</dt><dd>{refused.toLocaleString("en-IN")}</dd></div>
        <div><dt className="text-xs text-ink-500">Images stored</dt><dd>{job.imagesStored}{job.imagesFailed ? ` (${job.imagesFailed} failed)` : ""}</dd></div>
      </dl>
      {job.errorsByCode && Object.keys(job.errorsByCode).length ? (
        <div className="text-sm">
          <p className="text-xs font-semibold text-ink-600">Validation report</p>
          <ul className="flex flex-wrap gap-1">
            {Object.entries(job.errorsByCode).map(([code, n]) => (
              <li key={code}><Badge tone="warning">{`${code}: ${n}`}</Badge></li>
            ))}
          </ul>
        </div>
      ) : null}
      {job.lastError ? <Alert tone="warning">Last problem: {job.lastError}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {refused > 0 ? (
          <a className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 px-4 text-sm font-medium" href={`/api/pmd/jobs/${job.id}/errors`}>
            Download error file (CSV)
          </a>
        ) : null}
        {canResume && (job.status === "FAILED" || (job.status === "RUNNING" && job.lastError)) ? <Button size="sm" onClick={() => void resume()}>Resume</Button> : null}
      </div>
    </div>
  );
}
