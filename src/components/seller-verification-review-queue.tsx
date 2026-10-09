"use client";

/**
 * Admin review queue for seller documents (Part 3.7). Each item shows what
 * the government record said next to what the seller told us, why it needs a
 * person, and any uploaded certificate. Approve, ask for more information or
 * reject (a reason is required and is shown to the seller), or ask the vendor
 * again. Every decision notifies the seller and the other reviewers at once.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";
import type { SellerDocType, SellerVerificationStatus } from "@/lib/kyc/doc-formats";
import { reasonText, STATUS_LABELS, STATUS_TONES } from "@/lib/kyc/labels";

export interface QueueItem {
  id: string;
  shopId: string;
  shopName: string;
  city: string | null;
  ownerName: string | null;
  legalBusinessName: string | null;
  pincode: string | null;
  docType: SellerDocType;
  docLabel: string;
  status: SellerVerificationStatus;
  numberMasked: string | null;
  verifiedName: string | null;
  nameMatchScore: number | null;
  validUntil: string | null;
  lastErrorCode: string | null;
  details: Record<string, unknown>;
  attemptCount: number;
  files: { id: string; contentType: string }[];
  updatedAt: string;
}

const yesNo = (v: unknown) => (v === true ? "yes" : v === false ? "NO" : "—");

export function SellerVerificationReviewQueue({ items }: { items: QueueItem[] }) {
  if (items.length === 0) return <EmptyState title="No seller documents are waiting for review." />;
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <ReviewRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function ReviewRow({ item }: { item: QueueItem }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // Event layer: "reject" or "more_info" (send back to the seller saying what is missing).
  const [rejecting, setRejecting] = useState<"reject" | "more_info" | null>(null);
  const d = item.details;
  const declared = d.declaredNotRegistered === true;

  async function post(path: string, body?: unknown) {
    setBusy(path);
    setError(null);
    const response = await fetch(`/api/admin/seller-verifications/${item.id}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(null);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Action failed.");
      return;
    }
    setRejecting(null);
    setReason("");
    router.refresh();
  }

  return (
    <Card className="space-y-3 p-4" data-testid="seller-verification-review">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-ink-900">
            {item.shopName} <span className="font-normal text-ink-500">— {item.city ?? "?"} {item.pincode ?? ""}</span>
          </p>
          <p className="text-sm text-ink-700">
            {item.docLabel} · <span className="font-mono">{declared ? "no GSTIN (declared)" : item.numberMasked}</span>
          </p>
        </div>
        <Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge>
      </div>

      <p className="text-sm text-ink-600">
        Why: {reasonText(item.lastErrorCode) ?? item.lastErrorCode ?? "—"}
        {item.lastErrorCode ? <span className="ml-1 text-xs text-ink-500">({item.lastErrorCode})</span> : null}
      </p>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="inline text-ink-500">Owner: </dt><dd className="inline">{item.ownerName ?? "—"}</dd></div>
        <div><dt className="inline text-ink-500">Legal name: </dt><dd className="inline">{item.legalBusinessName ?? "—"}</dd></div>
        {declared ? (
          <div className="sm:col-span-2">
            <dt className="inline text-ink-500">GST enrolment number: </dt>
            <dd className="inline font-mono">{(d.enrolmentNumber as string) ?? "not given"}</dd>
          </div>
        ) : (
          <>
            <div><dt className="inline text-ink-500">Name on record: </dt><dd className="inline">{item.verifiedName ?? "—"}</dd></div>
            <div>
              <dt className="inline text-ink-500">Name match: </dt>
              <dd className="inline">{item.nameMatchScore ?? "—"}/100 {d.matchedShopName ? `(vs “${d.matchedShopName as string}”)` : ""}</dd>
            </div>
            {d.tradeName ? <div><dt className="inline text-ink-500">Trade name: </dt><dd className="inline">{d.tradeName as string}</dd></div> : null}
            {d.category ? <div><dt className="inline text-ink-500">Type: </dt><dd className="inline">{d.category as string}</dd></div> : null}
            {d.address ? <div className="sm:col-span-2"><dt className="inline text-ink-500">Address on record: </dt><dd className="inline">{d.address as string}</dd></div> : null}
            <div><dt className="inline text-ink-500">Status at source: </dt><dd className="inline">{(d.docStatus as string) ?? "—"}</dd></div>
            <div><dt className="inline text-ink-500">Valid until: </dt><dd className="inline">{item.validUntil ?? "—"}</dd></div>
            {item.docType === "GSTIN" ? <div><dt className="inline text-ink-500">GSTIN&apos;s PAN = shop PAN: </dt><dd className="inline">{yesNo(d.panLinked)}</dd></div> : null}
            {item.docType === "GSTIN" ? <div><dt className="inline text-ink-500">Same state: </dt><dd className="inline">{yesNo(d.stateMatch)}</dd></div> : null}
            <div><dt className="inline text-ink-500">Same PIN code: </dt><dd className="inline">{yesNo(d.pincodeMatch)}</dd></div>
            {typeof d.consistencyScore === "number" ? <div><dt className="inline text-ink-500">Consistency: </dt><dd className="inline">{d.consistencyScore as number}/100</dd></div> : null}
          </>
        )}
      </dl>

      {item.files.length ? (
        <p className="text-sm">
          Uploaded:{" "}
          {item.files.map((f, i) => (
            <a key={f.id} className="mr-2 text-kesari-700 underline" href={`/api/seller-verifications/files/${f.id}`} target="_blank" rel="noreferrer">
              {f.contentType === "application/pdf" ? "PDF" : "image"} {i + 1}
            </a>
          ))}
          <span className="text-xs text-ink-500">(opening a file is recorded)</span>
        </p>
      ) : item.docType === "SHOP_ACT" ? (
        <Alert tone="warning">No certificate uploaded yet.</Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-wrap gap-2 border-t border-cream-200 pt-3">
        <Button size="sm" disabled={busy !== null} onClick={() => post("decision", { decision: "approve", reason })}>
          {declared ? "Accept declaration" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy !== null}
          onClick={() => setRejecting(rejecting === "more_info" ? null : "more_info")}
        >
          Ask for more info
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy !== null}
          onClick={() => setRejecting(rejecting === "reject" ? null : "reject")}
        >
          Reject
        </Button>
        {!declared ? (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => post("recheck")}>
            {busy === "recheck" ? "Checking…" : "Re-check with vendor"}
          </Button>
        ) : null}
      </div>
      {rejecting ? (
        <div className="flex gap-2">
          <input
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              rejecting === "more_info"
                ? "What the seller must send (e.g. a clearer photo of the certificate)"
                : "Reason shown to the seller (e.g. certificate number doesn't match the upload)"
            }
          />
          <Button
            size="sm"
            variant={rejecting === "more_info" ? "primary" : "danger"}
            disabled={busy !== null || reason.trim().length < 3}
            onClick={() => post("decision", { decision: rejecting, reason })}
          >
            {rejecting === "more_info" ? "Send request" : "Confirm reject"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
