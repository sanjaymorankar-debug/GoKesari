import Link from "next/link";

import { Badge, Card } from "@/components/ui";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";
import { RIDER_KYC_STATUS_LABELS } from "@/lib/gig/kyc";
import type { AvailabilityGate } from "@/server/services/delivery-partners";
import type { BackgroundDocType, BackgroundDocView } from "@/server/services/rider-background-docs";
import type { MyRiderKyc, RiderKycCheckView } from "@/server/services/rider-kyc";

type Tone = "success" | "warning" | "danger" | "info";

const KYC_TONE: Record<RiderKycCheckView["status"], Tone> = { VERIFIED: "success", PENDING: "warning", FAILED: "danger" };
/** Module 6 (docs/hindi-marathi-2026-11/). */
const T = {
  notStarted: L("Not started", "शुरू नहीं हुआ", "सुरू झाले नाही"),
  notUploaded: L("Not uploaded", "अपलोड नहीं", "अपलोड केले नाही"),
  verification: L("Verification", "सत्यापन", "पडताळणी"),
  cleared: L("Cleared by GoKesari", "GoKesari ने मंज़ूर किया", "GoKesari ने मंजूर केले"),
  complete: L("Complete", "पूरा", "पूर्ण"),
  notRequired: L("Not required", "ज़रूरी नहीं", "आवश्यक नाही"),
  needed: L("Needed to go Active or Ready", "सक्रिय या तैयार होने के लिए ज़रूरी", "सक्रिय किंवा तयार होण्यासाठी आवश्यक"),
  police: L("Police verification form", "पुलिस सत्यापन फ़ॉर्म", "पोलीस पडताळणी फॉर्म"),
  character: L("Character certificate", "चरित्र प्रमाणपत्र", "चारित्र्य प्रमाणपत्र"),
} as const;

/** KYC check status words; English stays the shared RIDER_KYC_STATUS_LABELS. */
const KYC_STATUS_TEXT: Record<RiderKycCheckView["status"], Text> = {
  PENDING: L("Pending", "बाकी", "बाकी"),
  VERIFIED: L("Verified", "सत्यापित", "पडताळलेले"),
  FAILED: L("Failed", "असफल", "अयशस्वी"),
};

/** Police-document status words by code; anything unknown keeps the server's English label. */
const DOC_STATUS_TEXT: Record<string, Text> = {
  UPLOADED: L("Uploaded", "अपलोड हुआ", "अपलोड झाले"),
  UNDER_REVIEW: L("Under review", "जाँच चल रही है", "तपासणी सुरू आहे"),
  APPROVED: L("Approved", "मंज़ूर", "मंजूर"),
  REJECTED: L("Rejected", "अस्वीकृत", "नाकारले"),
};

const DOC_TONE: Record<BackgroundDocView["status"], Tone> = {
  UPLOADED: "info",
  UNDER_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "danger",
};

function Row({ label, status, tone, href, hint }: { label: string; status: string; tone: Tone; href: string; hint?: string | null }) {
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div>
        <Link href={href} className="font-medium text-ink-900 underline-offset-2 hover:underline">
          {label}
        </Link>
        {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
      </div>
      <Badge tone={tone}>{status}</Badge>
    </li>
  );
}

/**
 * Gig worker flow: where the partner stands on KYC (feature 2) and police
 * verification (feature 3), and whether that still blocks Active / Ready
 * (feature 5). Server component — statuses only, never a number or a file.
 */
export function RiderVerificationChecklist({
  kyc,
  documents,
  gate,
  lang = "en",
}: {
  kyc: MyRiderKyc;
  documents: BackgroundDocView[];
  gate: AvailabilityGate;
  lang?: Lang;
}) {
  const doc = (type: BackgroundDocType) => documents.find((d) => d.docType === type) ?? null;
  const kycRow = (label: string, check: RiderKycCheckView | null) =>
    check ? (
      <Row
        label={label}
        status={lang === "en" ? RIDER_KYC_STATUS_LABELS[check.status] : tr(KYC_STATUS_TEXT[check.status], lang)}
        tone={KYC_TONE[check.status]}
        href="/delivery-partner/kyc"
        hint={check.reason}
      />
    ) : (
      <Row label={label} status={tr(T.notStarted, lang)} tone="info" href="/delivery-partner/kyc" />
    );
  const docRow = (type: BackgroundDocType, label: string) => {
    const d = doc(type);
    return d ? (
      <Row
        label={label}
        status={lang !== "en" && DOC_STATUS_TEXT[d.status] ? tr(DOC_STATUS_TEXT[d.status], lang) : d.statusLabel}
        tone={DOC_TONE[d.status]}
        href="/delivery-partner/documents"
        hint={d.rejectionReason}
      />
    ) : (
      <Row label={label} status={tr(T.notUploaded, lang)} tone="info" href="/delivery-partner/documents" />
    );
  };

  return (
    <Card className="p-6" data-testid="rider-verification-checklist">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">{tr(T.verification, lang)}</h2>
        {gate.allowed ? (
          <Badge tone="success">
            {tr(gate.overridden && gate.missing.length ? T.cleared : gate.enforced ? T.complete : T.notRequired, lang)}
          </Badge>
        ) : (
          <Badge tone="warning">{tr(T.needed, lang)}</Badge>
        )}
      </div>
      <ul className="divide-y divide-cream-200 text-sm">
        {kycRow("PAN", kyc.pan)}
        {kycRow("Aadhaar", kyc.aadhaar)}
        {docRow("POLICE_VERIFICATION", tr(T.police, lang))}
        {docRow("CHARACTER_CERTIFICATE", tr(T.character, lang))}
      </ul>
    </Card>
  );
}
