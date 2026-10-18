"use client";

/**
 * One help desk ticket as its viewer may see it (F6.3.3, batch-2026-10 WS-C):
 * the conversation, files, and the actions this viewer has — reply; for the
 * requester close / reopen / rate; for the shop reply while support waits
 * for it; for support internal notes, canned replies, status, assignment
 * and escalation. Every action is checked again on the server.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { shrinkImage } from "@/components/image-uploader";
import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { TICKET_STATUS_STAFF_LABELS, type TicketStatus } from "@/lib/support-ticket-states";

export interface ThreadMessage {
  id: string;
  authorKind: string;
  authorLabel: string;
  body: string;
  internal: boolean;
  createdAt: string;
}

export interface ThreadFile {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  internal: boolean;
}

export interface ThreadProps {
  ticketId: string;
  access: "STAFF" | "REQUESTER" | "SHOP";
  messages: ThreadMessage[];
  files: ThreadFile[];
  can: { reply: boolean; close: boolean; reopen: boolean; rate: boolean; manage: boolean; nextStatuses: TicketStatus[] };
  csat: { rating: number; comment: string | null } | null;
  cannedReplies?: { id: string; title: string }[];
  staff?: { id: string; label: string }[];
  assigneeId?: string | null;
}

async function send(url: string, method: "POST" | "PATCH", body: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error?.message ?? "Something went wrong. Please try again.");
  return payload;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export function TicketThread(props: ThreadProps) {
  const router = useRouter();
  const base = `/api/support/tickets/${props.ticketId}`;
  const staff = props.access === "STAFF";
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [canned, setCanned] = useState("");
  const [thenStatus, setThenStatus] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [statusTo, setStatusTo] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [why, setWhy] = useState("");
  const [assignee, setAssignee] = useState(props.assigneeId ?? "");
  const [reopenWhy, setReopenWhy] = useState("");
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      setBody("");
      setFile(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function reply() {
    await act(async () => {
      if (body.trim() || canned) {
        await send(`${base}/messages`, "POST", {
          body: body.trim() || null,
          internal: staff ? internal : undefined,
          cannedReplyId: staff && canned ? canned : undefined,
          thenStatus: staff && thenStatus ? thenStatus : undefined,
        });
      }
      if (file) {
        const form = new FormData();
        form.append("file", file.type.startsWith("image/") ? await shrinkImage(file) : file, file.name);
        if (staff && internal) form.append("internal", "true");
        const res = await fetch(`${base}/attachments`, { method: "POST", body: form });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? "Could not add the file.");
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card className="divide-y divide-cream-100" data-testid="ticket-messages">
        {props.messages.length === 0 ? <p className="p-4 text-sm text-ink-500">No replies yet.</p> : null}
        {props.messages.map((m) => (
          <div key={m.id} className={m.internal ? "bg-amber-50 p-4" : "p-4"} data-internal={m.internal ? "true" : undefined}>
            <p className="text-xs text-ink-500">
              <span className="font-medium text-ink-700">{m.authorLabel}</span> · {when(m.createdAt)}
              {m.internal ? (
                <>
                  {" "}
                  · <Badge tone="warning">Internal note</Badge>
                </>
              ) : null}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-900">{m.body}</p>
          </div>
        ))}
      </Card>

      {props.files.length > 0 ? (
        <Card className="p-4">
          <p className="mb-2 text-sm font-medium text-ink-700">Files</p>
          <ul className="space-y-1 text-sm">
            {props.files.map((f) => (
              <li key={f.id}>
                <a href={`${base}/attachments/${f.id}`} target="_blank" rel="noreferrer" className="text-kesari-700 underline">
                  {f.fileName}
                </a>{" "}
                <span className="text-xs text-ink-500">({Math.ceil(f.sizeBytes / 1024)} KB)</span>
                {f.internal ? <Badge tone="warning">Support only</Badge> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {props.can.reply ? (
        <Card className="space-y-3 p-4">
          <Field label={staff && internal ? "Internal note (support only)" : "Your reply"}>
            <textarea className={inputClass} rows={4} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          {staff ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note
              </label>
              <Field label="Canned reply">
                <select className={inputClass} value={canned} onChange={(e) => setCanned(e.target.value)} disabled={internal}>
                  <option value="">None</option>
                  {(props.cannedReplies ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Then set status">
                <select className={inputClass} value={thenStatus} onChange={(e) => setThenStatus(e.target.value)}>
                  <option value="">Keep</option>
                  {props.can.nextStatuses.map((s) => (
                    <option key={s} value={s}>
                      {TICKET_STATUS_STAFF_LABELS[s]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : null}
          <Field label="Attach a photo or PDF (optional)">
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Button disabled={busy || (!body.trim() && !canned && !file)} onClick={reply}>
            {busy ? "Sending…" : staff && internal ? "Add note" : "Send"}
          </Button>
        </Card>
      ) : null}

      {props.can.close || props.can.reopen ? (
        <Card className="space-y-3 p-4">
          <p className="text-sm font-medium text-ink-900">Is your problem solved?</p>
          <div className="flex flex-wrap gap-2">
            {props.can.close ? (
              <Button disabled={busy} onClick={() => act(() => send(base, "PATCH", { action: "status", status: "CLOSED" }))}>
                Yes, close the ticket
              </Button>
            ) : null}
          </div>
          {props.can.reopen ? (
            <div className="space-y-2">
              <Field label="Not solved? Tell us why and we'll reopen it">
                <textarea className={inputClass} rows={2} value={reopenWhy} onChange={(e) => setReopenWhy(e.target.value)} />
              </Field>
              <Button variant="secondary" disabled={busy || reopenWhy.trim().length < 3} onClick={() => act(() => send(base, "PATCH", { action: "status", status: "REOPENED", note: reopenWhy }))}>
                Reopen ticket
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {props.can.rate ? (
        <Card className="space-y-3 p-4" id="rate">
          <p className="text-sm font-medium text-ink-900">How did we do?</p>
          <div className="flex gap-2" role="radiogroup" aria-label="Rating from 1 to 5">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                onClick={() => setRating(n)}
                className={`min-h-11 min-w-11 rounded-lg border text-lg ${rating >= n ? "border-amber-400 bg-amber-50" : "border-cream-200"}`}
              >
                ★
              </button>
            ))}
          </div>
          <Field label="Comment (optional)">
            <textarea className={inputClass} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
          <Button disabled={busy || rating === 0} onClick={() => act(() => send(`${base}/csat`, "POST", { rating, comment: comment.trim() || null }))}>
            Send rating
          </Button>
        </Card>
      ) : props.csat ? (
        <p className="text-sm text-ink-600">
          Rated {props.csat.rating}/5{props.csat.comment ? ` — “${props.csat.comment}”` : ""}. Thank you.
        </p>
      ) : null}

      {staff && props.can.manage ? (
        <Card className="space-y-4 p-4">
          <p className="text-sm font-semibold text-ink-900">Work this ticket</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Status">
              <select className={inputClass} value={statusTo} onChange={(e) => setStatusTo(e.target.value)}>
                <option value="">Choose</option>
                {props.can.nextStatuses.map((s) => (
                  <option key={s} value={s}>
                    {TICKET_STATUS_STAFF_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Note (shown to the requester; required to resolve)">
              <input className={inputClass} value={statusNote} onChange={(e) => setStatusNote(e.target.value)} />
            </Field>
          </div>
          <Button disabled={busy || !statusTo} onClick={() => act(() => send(base, "PATCH", { action: "status", status: statusTo, note: statusNote || null }))}>
            Update status
          </Button>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Assigned to">
              <select className={inputClass} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Nobody</option>
                {(props.staff ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <Button variant="secondary" disabled={busy} onClick={() => act(() => send(base, "PATCH", { action: "assign", assigneeId: assignee || null }))}>
                Save assignment
              </Button>
            </div>
          </div>
          {props.can.nextStatuses.includes("ESCALATED") ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Escalate — why?">
                <input className={inputClass} value={why} onChange={(e) => setWhy(e.target.value)} />
              </Field>
              <div className="flex items-end">
                <Button variant="danger" disabled={busy || why.trim().length < 3} onClick={() => act(() => send(base, "PATCH", { action: "escalate", why }))}>
                  Escalate
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
