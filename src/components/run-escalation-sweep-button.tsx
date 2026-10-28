"use client";

import { useState } from "react";

/** Admin-only manual run of the dispute escalation sweep. */
export function RunEscalationSweepButton() {
  const [state, setState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/escalation-sweep", { method: "POST" });
      const data = await res.json();
      setState(res.ok ? `Checked ${data.considered}, escalated ${data.escalated}.` : (data.message ?? "Failed."));
    } catch {
      setState("Failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3 flex items-center gap-3 text-sm">
      <button type="button" onClick={run} disabled={busy} className="rounded border px-3 py-1.5 disabled:opacity-50">
        {busy ? "Running…" : "Run escalation sweep now"}
      </button>
      {state ? <span>{state}</span> : null}
    </div>
  );
}
