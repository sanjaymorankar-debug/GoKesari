import Link from "next/link";

import { Badge, Card } from "@/components/ui";
import { RIDER_KYC_STATUS_LABELS } from "@/lib/gig/kyc";
import type { AvailabilityGate } from "@/server/services/delivery-partners";
import type { BackgroundDocType, BackgroundDocView } from "@/server/services/rider-background-docs";
import type { MyRiderKyc, RiderKycCheckView } from "@/server/services/rider-kyc";

type Tone = "success" | "warning" | "danger" | "info";

const KYC_TONE: Record<RiderKycCheckView["status"], Tone> = { VERIFIED: "success", PENDING: "warning", FAILED: "danger" };
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
}: {
  kyc: MyRiderKyc;
  documents: BackgroundDocView[];
  gate: AvailabilityGate;
}) {
  const doc = (type: BackgroundDocType) => documents.find((d) => d.docType === type) ?? null;
  const kycRow = (label: string, check: RiderKycCheckView | null) =>
    check ? (
      <Row label={label} status={RIDER_KYC_STATUS_LABELS[check.status]} tone={KYC_TONE[check.status]} href="/delivery-partner/kyc" hint={check.reason} />
    ) : (
      <Row label={label} status="Not started" tone="info" href="/delivery-partner/kyc" />
    );
  const docRow = (type: BackgroundDocType, label: string) => {
    const d = doc(type);
    return d ? (
      <Row label={label} status={d.statusLabel} tone={DOC_TONE[d.status]} href="/delivery-partner/documents" hint={d.rejectionReason} />
    ) : (
      <Row label={label} status="Not uploaded" tone="info" href="/delivery-partner/documents" />
    );
  };

  return (
    <Card className="p-6" data-testid="rider-verification-checklist">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Verification</h2>
        {gate.allowed ? (
          <Badge tone="success">{gate.overridden && gate.missing.length ? "Cleared by GoKesari" : gate.enforced ? "Complete" : "Not required"}</Badge>
        ) : (
          <Badge tone="warning">Needed to go Active or Ready</Badge>
        )}
      </div>
      <ul className="divide-y divide-cream-200 text-sm">
        {kycRow("PAN", kyc.pan)}
        {kycRow("Aadhaar", kyc.aadhaar)}
        {docRow("POLICE_VERIFICATION", "Police verification form")}
        {docRow("CHARACTER_CERTIFICATE", "Character certificate")}
      </ul>
    </Card>
  );
}
