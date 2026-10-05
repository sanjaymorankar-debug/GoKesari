"use client";

/**
 * Seller onboarding: verify PAN, GSTIN, Udyam, FSSAI and Shop Act documents.
 * One card per document, each with its own consent checkbox — consent is
 * asked for every check, not once for all (DPDP Act 2023, purpose-specific).
 * Numbers are checked for format here first, so obvious typos never reach
 * the server; the server checks again.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { GST_DECLARATION_TEXT, SELLER_VERIFICATION_CONSENT_TEXT } from "@/lib/kyc/consent";
import { parseSellerDocNumber, type SellerDocType, type SellerVerificationStatus } from "@/lib/kyc/doc-formats";
import { reasonText, STATUS_LABELS, STATUS_TONES } from "@/lib/kyc/labels";

export interface PanelDocument {
  id: string | null;
  docType: SellerDocType;
  label: string;
  requirement: "required" | "required_or_declaration" | "optional" | "not_applicable";
  status: SellerVerificationStatus;
  numberMasked: string | null;
  verifiedName: string | null;
  validUntil: string | null;
  lastErrorCode: string | null;
  reviewNote: string | null;
  declaredNotRegistered: boolean;
  files: { id: string; contentType: string; createdAt: string }[];
}

const PLACEHOLDERS: Record<SellerDocType, string> = {
  PAN: "ABCDE1234F",
  GSTIN: "27ABCDE1234F1Z5",
  UDYAM: "UDYAM-MH-26-0012345",
  FSSAI: "14-digit number",
  SHOP_ACT: "As printed on the certificate",
};

const REQUIREMENT_TEXT: Record<PanelDocument["requirement"], string> = {
  required: "Required",
  required_or_declaration: "Required — or declare you're not GST-registered",
  optional: "Optional",
  not_applicable: "Not needed",
};

async function errorMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null);
  return payload?.error?.message ?? "Something went wrong. Please try again.";
}

export function SellerVerificationPanel({ shopId, documents }: { shopId: string; documents: PanelDocument[] }) {
  return (
    <div className="space-y-4">
      {documents.map((doc) => (
        <DocumentCard key={doc.docType} shopId={shopId} doc={doc} />
      ))}
    </div>
  );
}

function DocumentCard({ shopId, doc }: { shopId: string; doc: PanelDocument }) {
  const router = useRouter();
  const [number, setNumber] = useState("");
  const [consent, setConsent] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(doc.status === "NOT_SUBMITTED");
  const [declaring, setDeclaring] = useState(false);
  const [declared, setDeclared] = useState(false);
  const [enrolment, setEnrolment] = useState("");

  const formatError = number.trim() ? (() => {
    const r = parseSellerDocNumber(doc.docType, number);
    return r.ok ? null : r.error;
  })() : null;
  const needsCertificate =
    doc.docType === "SHOP_ACT" && (doc.lastErrorCode === "vendor_unsupported" || doc.status === "NOT_SUBMITTED" || editing);

  async function submit() {
    setBusy(true);
    setError(null);
    let response: Response;
    if (doc.docType === "SHOP_ACT" && file) {
      const form = new FormData();
      form.set("file", file);
      form.set("number", number);
      form.set("consent", String(consent));
      response = await fetch(`/api/shops/${shopId}/verifications/shop-act-certificate`, { method: "POST", body: form });
    } else {
      response = await fetch(`/api/shops/${shopId}/verifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docType: doc.docType, number, consent }),
      });
    }
    setBusy(false);
    if (!response.ok) {
      setError(await errorMessage(response));
      return;
    }
    setNumber("");
    setConsent(false);
    setFile(null);
    setEditing(false);
    router.refresh();
  }

  async function declareNoGst() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/shops/${shopId}/verifications/gst-declaration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ declaration: declared, enrolmentNumber: enrolment || null }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(await errorMessage(response));
      return;
    }
    setDeclaring(false);
    router.refresh();
  }

  const reason = doc.reviewNote ?? reasonText(doc.lastErrorCode);
  const canSubmit = consent && number.trim() && !formatError && !busy && (doc.docType !== "SHOP_ACT" || !needsCertificate || file);

  return (
    <Card className="space-y-3 p-4" data-testid={`verification-${doc.docType}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-ink-900">{doc.label}</p>
          <p className="text-xs text-ink-500">{REQUIREMENT_TEXT[doc.requirement]}</p>
        </div>
        <Badge tone={STATUS_TONES[doc.status]}>{doc.declaredNotRegistered && doc.status === "VERIFIED" ? "Declaration accepted" : STATUS_LABELS[doc.status]}</Badge>
      </div>

      {doc.status !== "NOT_SUBMITTED" ? (
        <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
          {doc.declaredNotRegistered ? (
            <div className="sm:col-span-2 text-ink-700">You declared this shop is not GST-registered.</div>
          ) : (
            <div>
              <dt className="inline text-ink-500">Number: </dt>
              <dd className="inline font-mono text-ink-900">{doc.numberMasked}</dd>
            </div>
          )}
          {doc.verifiedName ? (
            <div>
              <dt className="inline text-ink-500">Name on record: </dt>
              <dd className="inline text-ink-900">{doc.verifiedName}</dd>
            </div>
          ) : null}
          {doc.validUntil ? (
            <div>
              <dt className="inline text-ink-500">Valid until: </dt>
              <dd className="inline text-ink-900">{doc.validUntil}</dd>
            </div>
          ) : null}
          {doc.files.length ? (
            <div>
              <dt className="inline text-ink-500">Certificate: </dt>
              <dd className="inline">
                <a className="text-kesari-700 underline" href={`/api/seller-verifications/files/${doc.files[doc.files.length - 1].id}`} target="_blank" rel="noreferrer">
                  view upload
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {reason && doc.status !== "VERIFIED" ? <Alert tone={doc.status === "FAILED" || doc.status === "EXPIRED" ? "danger" : "info"}>{reason}</Alert> : null}

      {!editing && doc.status !== "NOT_SUBMITTED" ? (
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
          {doc.status === "VERIFIED" ? "Replace" : "Submit again"}
        </Button>
      ) : null}

      {editing && !declaring ? (
        <div className="space-y-3 border-t border-cream-200 pt-3">
          <Field label={`${doc.label} number`} error={formatError ?? undefined}>
            <input
              className={inputClass}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder={PLACEHOLDERS[doc.docType]}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {doc.docType === "SHOP_ACT" ? (
            <Field
              label="Certificate or Form G receipt (PDF or photo, up to 5 MB)"
              hint="In Maharashtra, shops with fewer than 10 workers have a Form G intimation receipt instead of a registration certificate — either is fine."
            >
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm"
              />
            </Field>
          ) : null}
          <label className="flex items-start gap-2 text-xs text-ink-700">
            <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{SELLER_VERIFICATION_CONSENT_TEXT}</span>
          </label>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!canSubmit} onClick={submit}>
              {busy ? "Checking…" : "Verify"}
            </Button>
            {doc.docType === "GSTIN" ? (
              <Button size="sm" variant="ghost" onClick={() => setDeclaring(true)}>
                I&apos;m not GST-registered
              </Button>
            ) : null}
            {doc.status !== "NOT_SUBMITTED" ? (
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {declaring ? (
        <div className="space-y-3 border-t border-cream-200 pt-3">
          <Field
            label="GST enrolment number (if you have one)"
            hint="Unregistered sellers supplying through an online marketplace get this from the GST portal."
          >
            <input className={inputClass} value={enrolment} onChange={(e) => setEnrolment(e.target.value)} autoComplete="off" />
          </Field>
          <label className="flex items-start gap-2 text-xs text-ink-700">
            <input type="checkbox" className="mt-0.5" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
            <span>{GST_DECLARATION_TEXT}</span>
          </label>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex gap-2">
            <Button size="sm" disabled={!declared || busy} onClick={declareNoGst}>
              Submit declaration
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDeclaring(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
