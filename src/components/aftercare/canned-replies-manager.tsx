"use client";

/** Admin: the help desk's canned replies — add, edit, retire (F6.3.3, batch-2026-10 WS-C). */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

export interface CannedRow {
  id: string;
  title: string;
  body: string;
  category: string | null;
  active: boolean;
}

export function CannedRepliesManager({ rows }: { rows: CannedRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<CannedRow | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function edit(row: CannedRow | null) {
    setEditing(row);
    setTitle(row?.title ?? "");
    setBody(row?.body ?? "");
    setError(null);
  }

  async function call(url: string, method: string, payload?: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method,
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error?.message ?? "Could not save.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function save() {
    const ok = editing
      ? await call(`/api/support/canned-replies/${editing.id}`, "PATCH", { title, body, active: true })
      : await call("/api/support/canned-replies", "POST", { title, body });
    if (ok) edit(null);
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5">
        <p className="text-sm font-semibold text-ink-900">{editing ? `Edit “${editing.title}”` : "New canned reply"}</p>
        <Field label="Title">
          <input className={inputClass} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Reply" hint="You can use {{name}}, {{ticketNumber}} and {{orderNumber}}.">
          <textarea className={inputClass} rows={5} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || title.trim().length < 2 || body.trim().length < 5} onClick={save}>
            {editing ? "Save changes" : "Add reply"}
          </Button>
          {editing ? (
            <Button variant="secondary" onClick={() => edit(null)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </Card>
      <div className="space-y-3">
        {rows.map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium text-ink-900">
                {r.title} {r.active ? null : <Badge tone="neutral">Retired</Badge>}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => edit(r)}>
                  Edit
                </Button>
                {r.active ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => call(`/api/support/canned-replies/${r.id}`, "DELETE")}>
                    Retire
                  </Button>
                ) : null}
              </div>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-600">{r.body}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
