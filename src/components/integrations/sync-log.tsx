"use client";

/** Module 2: the shop's sync entries (failed first, with Retry) and log, in plain words. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";

export interface JobRow {
  id: string;
  kind: "PUSH_INVOICE" | "PUSH_CREDIT_NOTE" | "PULL_ITEMS" | "TEST_CONNECTION";
  status: string;
  number: string | null;
  attempts: number;
  nextAttemptAt: string;
  externalRef: string | null;
  error: { code: string; message: string; fix: string } | null;
  errorDetail: string | null;
  createdAt: string;
}

export interface LogRow {
  id: string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  createdAt: string;
}

const KIND: Record<JobRow["kind"], string> = {
  PUSH_INVOICE: "Invoice",
  PUSH_CREDIT_NOTE: "Credit note",
  PULL_ITEMS: "Item sync",
  TEST_CONNECTION: "Connection test",
};

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function SyncLog({ shopId, jobs, log }: { shopId: string; jobs: JobRow[]; log: LogRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failed = jobs.filter((j) => j.status === "DEAD");
  const retrying = jobs.filter((j) => j.status === "FAILED");
  const waiting = jobs.filter((j) => j.status === "PENDING" || j.status === "CLAIMED");

  async function retry(job: JobRow) {
    setBusy(job.id);
    setError(null);
    const res = await fetch(`/api/shops/${shopId}/integration/jobs/${job.id}/retry`, { method: "POST" });
    setBusy(null);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? "Could not retry.");
    }
    router.refresh();
  }

  const row = (job: JobRow) => (
    <li key={job.id} className="space-y-1 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink-900">
          {KIND[job.kind]} {job.number ?? ""}
          <span className="ml-2 text-xs font-normal text-ink-500">{when(job.createdAt)}</span>
        </span>
        {job.status === "DEAD" || job.status === "FAILED" ? (
          <Button size="sm" disabled={busy === job.id} onClick={() => void retry(job)}>Retry now</Button>
        ) : null}
      </div>
      {job.error ? (
        <p className="text-sm text-ink-700">
          {job.error.message} <span className="text-ink-500">{job.error.fix}</span>
          {job.status === "FAILED" ? <span className="block text-xs text-ink-500">Trying again automatically at {when(job.nextAttemptAt)} (attempt {job.attempts}).</span> : null}
        </p>
      ) : null}
      {job.errorDetail ? <pre className="overflow-x-auto rounded bg-cream-100 p-2 text-xs">{job.errorDetail}</pre> : null}
    </li>
  );

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card className="p-4">
        <h2 className="text-base font-semibold text-ink-900">Needs your attention {failed.length ? <Badge tone="danger">{failed.length}</Badge> : null}</h2>
        {failed.length ? <ul className="divide-y divide-cream-200">{failed.map(row)}</ul> : <p className="mt-1 text-sm text-ink-500">Nothing failed. 👍</p>}
      </Card>
      {retrying.length ? (
        <Card className="p-4">
          <h2 className="text-base font-semibold text-ink-900">Trying again automatically</h2>
          <ul className="divide-y divide-cream-200">{retrying.map(row)}</ul>
        </Card>
      ) : null}
      {waiting.length ? (
        <Card className="p-4">
          <h2 className="text-base font-semibold text-ink-900">Waiting to be sent ({waiting.length})</h2>
          <ul className="divide-y divide-cream-200">{waiting.slice(0, 20).map(row)}</ul>
        </Card>
      ) : null}
      <Card className="p-4">
        <h2 className="text-base font-semibold text-ink-900">Sync log</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {log.map((l) => (
            <li key={l.id} className="flex gap-2">
              <span className="w-28 shrink-0 text-xs text-ink-500">{when(l.createdAt)}</span>
              <span className={l.level === "ERROR" ? "text-red-700" : l.level === "WARN" ? "text-amber-700" : "text-ink-700"}>{l.message}</span>
            </li>
          ))}
          {log.length === 0 ? <li className="text-ink-500">Nothing yet.</li> : null}
        </ul>
      </Card>
    </div>
  );
}
