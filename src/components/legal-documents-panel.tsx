"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import {
  LEGAL_DOC_NEEDS,
  LEGAL_DOC_STATE_LABELS,
  LEGAL_DOC_WHO,
  MEDICAL_COUNCILS,
  parseLegalDocNumber,
  type LegalDocKey,
  type LegalDocState,
} from "@/lib/legal-documents";

export interface LegalDocCard {
  id: string | null;
  docType: LegalDocKey;
  label: string;
  state: LegalDocState;
  numberMasked: string | null;
  issuingCouncil: string | null;
  expiryDate: string | null;
  rejectionReason: string | null;
  deadline: string | null;
  blocking: boolean;
  expiringSoon: boolean;
  files: { id: string; contentType: string; createdAt: string }[];
}

const STATE_TONES: Record<LegalDocState, "success" | "info" | "warning" | "danger"> = {
  APPROVED: "success",
  SUBMITTED: "info",
  MISSING: "warning",
  REJECTED: "danger",
  EXPIRED: "danger",
};

/** "Drug licence" → "drug licence" mid-sentence; an acronym such as FSSAI keeps its capitals. */
const inSentence = (label: string) => label.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/**
 * Legal documents section (docs/four-features-2026-10, feature 2): the
 * licences this shop must hold, their state, the deadline, and the upload
 * form (number, expiry date or issuing council, and a copy). The server
 * repeats every check.
 */
export function LegalDocumentsPanel({ shopId, documents }: { shopId: string; documents: LegalDocCard[] }) {
  return (
    <div className="space-y-4" id="legal-documents">
      {documents.map((doc) => (
        <LegalDocCardView key={doc.docType} shopId={shopId} doc={doc} />
      ))}
    </div>
  );
}

function LegalDocCardView({ shopId, doc }: { shopId: string; doc: LegalDocCard }) {
  const router = useRouter();
  const needs = LEGAL_DOC_NEEDS[doc.docType];
  const [open, setOpen] = useState(doc.state === "MISSING" || doc.state === "REJECTED" || doc.state === "EXPIRED");
  const [number, setNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [council, setCouncil] = useState<string>(MEDICAL_COUNCILS[0]);
  const [otherCouncil, setOtherCouncil] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const numberCheck = number.trim() ? parseLegalDocNumber(doc.docType, number) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setNotice(null);
    const form = new FormData();
    form.set("docType", doc.docType);
    form.set("number", number);
    if (needs.expiry) form.set("expiryDate", expiryDate);
    if (needs.council) form.set("issuingCouncil", council === "Other" ? otherCouncil : council);
    if (file) form.set("file", file);
    try {
      const response = await fetch(`/api/shops/${shopId}/legal-documents`, { method: "POST", body: form });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setFieldErrors(payload?.error?.details?.fields ?? {});
        throw new Error(payload?.error?.message ?? "Could not upload the document.");
      }
      setNotice("Submitted — operations will review it. You can keep taking orders meanwhile.");
      setOpen(false);
      setNumber("");
      setFile(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not upload the document.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" data-testid={`legal-doc-${doc.docType}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-ink-900">{doc.label}</h2>
          <p className="text-xs text-ink-500">Required for: {LEGAL_DOC_WHO[doc.docType]}</p>
        </div>
        <Badge tone={STATE_TONES[doc.state]}>{LEGAL_DOC_STATE_LABELS[doc.state]}</Badge>
      </div>

      <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        {doc.numberMasked ? (
          <>
            <dt className="text-ink-500">Number</dt>
            <dd className="font-mono text-ink-900">{doc.numberMasked}</dd>
          </>
        ) : null}
        {doc.expiryDate ? (
          <>
            <dt className="text-ink-500">Expires</dt>
            <dd className="text-ink-900">{dateLabel(`${doc.expiryDate}T00:00:00+05:30`)}</dd>
          </>
        ) : null}
        {doc.issuingCouncil ? (
          <>
            <dt className="text-ink-500">Issued by</dt>
            <dd className="text-ink-900">{doc.issuingCouncil}</dd>
          </>
        ) : null}
      </dl>
      {doc.files[0] ? (
        <p className="mt-2 text-xs">
          <a className="font-medium text-kesari-700 hover:underline" href={`/api/legal-documents/files/${doc.files[0].id}`} target="_blank" rel="noreferrer">
            View uploaded copy
          </a>
        </p>
      ) : null}

      {doc.state === "REJECTED" && doc.rejectionReason ? (
        <div className="mt-3">
          <Alert tone="danger" title="Rejected by operations">{doc.rejectionReason}</Alert>
        </div>
      ) : null}
      {doc.blocking ? (
        <div className="mt-3">
          <Alert tone="danger" title="Your shop cannot accept orders">Upload your {inSentence(doc.label)} to start taking orders again.</Alert>
        </div>
      ) : doc.deadline ? (
        <div className="mt-3">
          <Alert tone="warning" title={`Upload by ${dateLabel(doc.deadline)}`}>
            Until then your shop keeps taking orders. After that date it cannot accept orders until the {inSentence(doc.label)} is uploaded.
          </Alert>
        </div>
      ) : null}
      {doc.expiringSoon && doc.expiryDate ? (
        <div className="mt-3">
          <Alert tone="warning" title="Expires soon">
            Your {inSentence(doc.label)} expires on {dateLabel(`${doc.expiryDate}T00:00:00+05:30`)}. Upload the renewed licence before then.
          </Alert>
        </div>
      ) : null}

      {!open ? (
        <div className="mt-3">
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            {doc.state === "MISSING" ? "Upload" : "Upload a new copy"}
          </Button>
        </div>
      ) : (
        <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
          <Field label={`${doc.label} number`} hint={needs.numberHint} error={fieldErrors.number ?? (numberCheck && !numberCheck.ok ? numberCheck.error : undefined)}>
            <input
              className={inputClass}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              inputMode={doc.docType === "FSSAI" ? "numeric" : "text"}
              maxLength={40}
              required
              aria-label={`${doc.label} number`}
            />
          </Field>
          {needs.expiry ? (
            <Field label="Expiry date" error={fieldErrors.expiryDate}>
              <input className={inputClass} type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} required aria-label="Expiry date" />
            </Field>
          ) : null}
          {needs.council ? (
            <Field label="Issuing council" error={fieldErrors.issuingCouncil}>
              <select className={inputClass} value={council} onChange={(e) => setCouncil(e.target.value)} aria-label="Issuing council">
                {MEDICAL_COUNCILS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                <option value="Other">Other…</option>
              </select>
              {council === "Other" ? (
                <input className={`${inputClass} mt-2`} value={otherCouncil} onChange={(e) => setOtherCouncil(e.target.value)} placeholder="Council name" aria-label="Other council" />
              ) : null}
            </Field>
          ) : null}
          <Field label="Copy of the document" hint="PDF, JPEG, PNG or WebP, up to 5 MB" error={fieldErrors.file}>
            <input
              className="block w-full text-sm"
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
              aria-label="Document file"
            />
          </Field>
          <div className="flex items-end gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy || !file || !number.trim() || (numberCheck != null && !numberCheck.ok)}>
              {busy ? "Uploading…" : "Submit for review"}
            </Button>
            {doc.state !== "MISSING" ? (
              <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      )}
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      {notice ? <p className="mt-3 text-sm text-leaf-700">{notice}</p> : null}
    </Card>
  );
}
