"use client";

/** Manufacturer catalogue upload (batch-2026-10 WS-D, F9.1.2): the template file → a validated, staged import. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button } from "@/components/ui";

export function ManufacturerUpload() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/pmd/manufacturer/uploads", { method: "POST", body: new FormData(e.currentTarget) });
    const data = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(data?.error?.message ?? "The upload failed.");
      return;
    }
    router.push(`/manufacturer/jobs/${data.job.id}`);
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-cream-200 bg-white p-4">
      <input name="file" type="file" required accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="block min-h-11 w-full text-sm" />
      <Button type="submit" disabled={busy}>{busy ? "Checking the file…" : "Upload"}</Button>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </form>
  );
}
