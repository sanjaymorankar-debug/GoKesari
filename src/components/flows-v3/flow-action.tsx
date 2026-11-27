"use client";

/**
 * docs/flows-v3/wave2.md: one button that calls a flows-v3 endpoint, with an optional note box, and refreshes the
 * page. Used by the order, return and shop order pages for the wave-2 actions (each shown only while its flag is on).
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

export function FlowAction({
  url,
  method = "POST",
  body = {},
  label,
  variant = "secondary",
  noteLabel,
  noteField = "note",
  noteRequired = false,
  confirmText,
  doneText,
  testId,
}: {
  url: string;
  method?: "POST" | "DELETE";
  body?: Record<string, unknown>;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  /** Shows a text box first; its value is sent as `noteField`. */
  noteLabel?: string;
  noteField?: string;
  noteRequired?: boolean;
  confirmText?: string;
  doneText?: string;
  testId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function run() {
    if (noteLabel && !open) {
      setOpen(true);
      return;
    }
    if (noteRequired && note.trim().length < 10) {
      setError("Please write a little more (at least 10 characters).");
      return;
    }
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(noteLabel ? { ...body, [noteField]: note.trim() || null } : body),
    });
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "That did not work. Please try again.");
      return;
    }
    setDone(true);
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="space-y-2" data-testid={testId}>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {done && doneText ? <Alert tone="success">{doneText}</Alert> : null}
      {open && noteLabel ? (
        <label className="block text-sm text-ink-700">
          {noteLabel}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} className={inputClass} />
        </label>
      ) : null}
      {!done ? (
        <Button size="sm" variant={variant} disabled={busy} onClick={run}>
          {label}
        </Button>
      ) : null}
    </div>
  );
}
