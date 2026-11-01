import { redirect } from "next/navigation";

import { RiderVerificationAdmin } from "@/components/rider-verification-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listDeliveryPartners } from "@/server/services/delivery-partners";
import { listBackgroundDocsForAdmin } from "@/server/services/rider-background-docs";
import { listRiderKycChecksForAdmin } from "@/server/services/rider-kyc";

export const metadata = { title: "Rider verification" };
export const dynamic = "force-dynamic";

/**
 * Gig worker flow (docs/gig-worker-2026-10): admins only. PAN / Aadhaar checks
 * (masked), police verification forms and character certificates (every file
 * opening audited), the Active / Ready gate override and per-society access.
 */
export default async function RiderVerificationPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const [kyc, docs, partners] = await Promise.all([
    listRiderKycChecksForAdmin(user),
    listBackgroundDocsForAdmin(user),
    listDeliveryPartners({ limit: 200 }),
  ]);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Rider verification"
        description="PAN and Aadhaar checks, police verification documents, the verification gate on Active / Ready, and which societies each partner may deliver to."
      />
      <RiderVerificationAdmin
        kyc={kyc.map((c) => ({
          id: c.id,
          docType: c.docType,
          status: c.status,
          numberMasked: c.numberMasked,
          reason: c.reason,
          adminReason: c.adminReason,
          method: c.method,
          sessionStatus: c.sessionStatus,
          sessionExpiresAt: c.sessionExpiresAt?.toISOString() ?? null,
          canResend: c.canResend,
          riderName: c.riderName,
          riderMobile: c.riderMobile,
          nameOnRecord: c.nameOnRecord,
          nameMatchScore: c.nameMatchScore,
          provider: c.provider,
          updatedAt: c.updatedAt.toISOString(),
        }))}
        docs={docs.map((d) => ({
          id: d.id,
          label: d.label,
          status: d.status,
          statusLabel: d.statusLabel,
          rejectionReason: d.rejectionReason,
          contentType: d.contentType,
          sizeBytes: d.sizeBytes,
          riderName: d.riderName,
          riderMobile: d.riderMobile,
          fileUrl: d.fileUrl,
          createdAt: d.createdAt.toISOString(),
        }))}
        partners={partners
          .filter((p) => p.status !== "DEACTIVATED")
          .map((p) => ({
            id: p.id,
            fullName: p.fullName,
            mobile: p.mobile,
            status: p.status,
            availability: p.availability,
            overridden: Boolean(p.availabilityOverrideAt),
            overrideReason: p.availabilityOverrideReason,
          }))}
      />
    </div>
  );
}
