"use client";

/**
 * Event layer: a dispute case as its three parties see it — the customer
 * opening it (DisputeOpenForm) and the conversation afterwards (DisputeCase).
 * Every message and status change here notifies the other parties at once;
 * support's money decisions stay on /admin/disputes.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ImageUploader, type UploadedImage } from "@/components/image-uploader";
import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import {
  DISPUTE_LEVEL_LABELS,
  DISPUTE_REASONS,
  DISPUTE_REASON_LABELS,
  DISPUTE_STATUS_LABELS,
  type DisputeLevel,
  type DisputeReason,
  type DisputeStatus,
} from "@/lib/dispute-states";
import { formatPaise } from "@/lib/money";

const requestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

async function send(url: string, method: "POST" | "PATCH", body: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error?.message ?? "Something went wrong. Please try again.");
  return payload;
}

/** Customer: raise a dispute on a delivered order — reason, what happened, amount, photos. */
export function DisputeOpenForm({ orderId, orderTotalPaise }: { orderId: string; orderTotalPaise: number }) {
  const router = useRouter();
  const [reason, setReason] = useState<DisputeReason | "">("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState((orderTotalPaise / 100).toFixed(2));
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!reason) return setError("Choose what went wrong.");
    if (description.trim().length < 10) return setError("Describe the problem in a little more detail.");
    const paise = Math.round(Number(amount) * 100);
    if (!Number.isFinite(paise) || paise <= 0 || paise > orderTotalPaise) {
      return setError(`Enter an amount between ₹0.01 and ${formatPaise(orderTotalPaise)}.`);
    }
    setBusy(true);
    try {
      const dispute = await send("/api/disputes", "POST", {
        orderId,
        reason,
        description: description.trim(),
        disputedAmountPaise: paise,
        imageIds: images.map((i) => i.id),
      });
      router.push(`/disputes/${dispute.id}?opened=1`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open the dispute.");
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <Field label="What went wrong?">
        <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value as DisputeReason)}>
          <option value="">Choose a reason</option>
          {DISPUTE_REASONS.map((r) => (
            <option key={r} value={r}>
              {DISPUTE_REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Tell us what happened">
        <textarea
          className={inputClass}
          rows={4}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Two of the three milk packets were leaking when they arrived."
        />
      </Field>
      <Field label="Amount in dispute (₹)" hint={`At most the order total, ${formatPaise(orderTotalPaise)}.`}>
        <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <div>
        <p className="mb-1 text-sm font-medium text-ink-700">Photos (optional)</p>
        <ImageUploader purpose="DISPUTE_EVIDENCE" value={images} onChange={setImages} />
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button onClick={() => void submit()} disabled={busy}>
        {busy ? "Opening…" : "Open dispute"}
      </Button>
    </Card>
  );
}

export interface DisputeCaseView {
  id: string;
  caseNumber: string;
  orderNumber: string;
  shopName: string;
  status: DisputeStatus;
  level: DisputeLevel;
  reason: DisputeReason;
  description: string;
  disputedAmountPaise: number;
  createdAt: string;
  viewerParty: "CUSTOMER" | "SHOP" | "SUPPORT";
  closed: boolean;
  images: { id: string; url: string }[];
  comments: {
    id: string;
    authorLabel: string;
    authorParty: "CUSTOMER" | "SHOP" | "SUPPORT";
    body: string;
    internal: boolean;
    createdAt: string;
    images: { id: string; url: string }[];
  }[];
}

function Photos({ images }: { images: { id: string; url: string }[] }) {
  if (images.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((image) => (
        <a key={image.id} href={image.url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.url} alt="Photo on the dispute" className="h-20 w-20 rounded-lg border border-cream-200 object-cover" />
        </a>
      ))}
    </div>
  );
}

/** The case: what was raised, the conversation, and a reply box for whichever party is looking. */
export function DisputeCase({ view, justOpened = false }: { view: DisputeCaseView; justOpened?: boolean }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [proposal, setProposal] = useState("");
  const [proposing, setProposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per message being written: a double tap or a retry posts it once.
  const [pendingId, setPendingId] = useState(requestId);

  async function reply() {
    setError(null);
    if (body.trim().length < 2) return setError("Write a message.");
    setBusy(true);
    try {
      await send(`/api/disputes/${view.id}/comments`, "POST", {
        body: body.trim(),
        internal: view.viewerParty === "SUPPORT" ? internal : undefined,
        imageIds: images.map((i) => i.id),
        clientRequestId: pendingId,
      });
      setBody("");
      setImages([]);
      setInternal(false);
      setPendingId(requestId());
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the message.");
    } finally {
      setBusy(false);
    }
  }

  async function propose() {
    setError(null);
    if (proposal.trim().length < 3) return setError("Say what you are offering the customer.");
    setBusy(true);
    try {
      await send(`/api/disputes/${view.id}`, "PATCH", { action: "advance", to: "RESOLUTION_PROPOSED", proposal: proposal.trim() });
      setProposal("");
      setProposing(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the proposal.");
    } finally {
      setBusy(false);
    }
  }

  const canPropose =
    view.viewerParty === "SHOP" &&
    view.level === "L1" &&
    !view.closed &&
    // Support triages a new case first (the dispute lifecycle); until then the shop replies in words.
    ["TRIAGED", "INVESTIGATING"].includes(view.status);

  return (
    <div className="space-y-4">
      {justOpened ? (
        <Alert tone="success" title={`Dispute ${view.caseNumber} opened`}>
          Keep this number for reference. The shop and our support team have been told, and you will be notified of
          every reply here.
        </Alert>
      ) : null}

      <Card className="space-y-2 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink-900">
            Dispute <span className="font-mono">{view.caseNumber}</span>
          </h2>
          <div className="flex gap-2">
            <Badge>{DISPUTE_STATUS_LABELS[view.status]}</Badge>
            {view.level === "L2" ? <Badge>{DISPUTE_LEVEL_LABELS.L2}</Badge> : null}
          </div>
        </div>
        <p className="text-sm text-ink-600">
          Order {view.orderNumber} · {view.shopName} · {DISPUTE_REASON_LABELS[view.reason]} ·{" "}
          {formatPaise(view.disputedAmountPaise)} · opened {new Date(view.createdAt).toLocaleString("en-IN")}
        </p>
        <p className="whitespace-pre-line text-sm text-ink-800">{view.description}</p>
        <Photos images={view.images} />
      </Card>

      <Card className="space-y-3 p-5">
        <h3 className="text-base font-semibold text-ink-900">Conversation</h3>
        {view.comments.length === 0 ? (
          <p className="text-sm text-ink-500">No replies yet.</p>
        ) : (
          <ul className="space-y-3">
            {view.comments.map((c) => (
              <li
                key={c.id}
                className={c.internal ? "rounded-lg border border-amber-200 bg-amber-50 p-3" : "rounded-lg border border-cream-200 p-3"}
              >
                <p className="text-xs text-ink-500">
                  <span className="font-medium text-ink-700">{c.authorLabel}</span> ·{" "}
                  {new Date(c.createdAt).toLocaleString("en-IN")}
                  {c.internal ? " · internal note (support only)" : ""}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm text-ink-800">{c.body}</p>
                <Photos images={c.images} />
              </li>
            ))}
          </ul>
        )}

        {view.closed ? (
          <p className="text-sm text-ink-500">This dispute is closed.</p>
        ) : (
          <div className="space-y-2 border-t border-cream-200 pt-3">
            <Field label="Reply">
              <textarea
                className={inputClass}
                rows={3}
                maxLength={2000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={view.viewerParty === "SHOP" ? "Your side of what happened" : "Write a message"}
              />
            </Field>
            <ImageUploader purpose="DISPUTE_EVIDENCE" value={images} onChange={setImages} label="Add photos" />
            {view.viewerParty === "SUPPORT" ? (
              <label className="flex items-center gap-2 text-sm text-ink-700">
                <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                Internal note — support only
              </label>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void reply()} disabled={busy}>
                {busy ? "Sending…" : "Send"}
              </Button>
              {canPropose ? (
                <Button size="sm" variant="secondary" onClick={() => setProposing(!proposing)} disabled={busy}>
                  Propose a resolution
                </Button>
              ) : null}
            </div>
            {proposing ? (
              <div className="flex flex-wrap gap-2">
                <input
                  className={inputClass}
                  value={proposal}
                  onChange={(e) => setProposal(e.target.value)}
                  placeholder="e.g. We will replace the two packets with your next order."
                />
                <Button size="sm" onClick={() => void propose()} disabled={busy}>
                  Send proposal
                </Button>
              </div>
            ) : null}
          </div>
        )}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </Card>
    </div>
  );
}
