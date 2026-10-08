import { redirect } from "next/navigation";

import { LegalDocumentReviewQueue } from "@/components/legal-document-review-queue";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listLegalDocumentsForReview, type ReviewFilter } from "@/server/services/legal-documents";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Legal documents" };
export const dynamic = "force-dynamic";

const FILTERS: ReviewFilter[] = ["to_review", "rejected", "approved", "missing", "expiring", "all"];

/** Operations: review shops' FSSAI / drug licence / medical registration (docs/four-features-2026-10, feature 2). */
export default async function AdminLegalDocumentsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_GST_PAN_VERIFY)) redirect("/");
  const params = await searchParams;
  const filter = (FILTERS as string[]).includes(params.filter ?? "") ? (params.filter as ReviewFilter) : "to_review";
  const [documents, rule] = await Promise.all([listLegalDocumentsForReview(filter, user), getRule("legalDocuments")]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Legal documents"
        description={`FSSAI licences, drug licences and medical registrations. Live shops get ${rule.graceDays} days to upload; owners are reminded ${rule.expiryReminderDays} days before expiry.`}
      />
      {!rule.enabled ? <Alert tone="info">Mandatory legal documents are switched off (Business rules → legalDocuments).</Alert> : null}
      <LegalDocumentReviewQueue filter={filter} documents={documents} />
    </div>
  );
}
