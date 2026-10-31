import { redirect } from "next/navigation";

import { RiderBackgroundDocsForm } from "@/components/rider-background-docs-form";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { BACKGROUND_DOC_LABELS, listMyBackgroundDocs } from "@/server/services/rider-background-docs";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Police verification documents" };
export const dynamic = "force-dynamic";

/** Gig worker flow (feature 3): step 3 of registration. */
export default async function RiderBackgroundDocsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner/register");
  const [documents, rule] = await Promise.all([listMyBackgroundDocs(user.id), getRule("riderVerification")]);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Police verification documents"
        description="Step 3 of 3. Upload your police verification form and character certificate. They are stored privately and only GoKesari's verification team can open them."
      />
      <RiderBackgroundDocsForm
        documents={documents.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }))}
        slots={[
          { docType: "POLICE_VERIFICATION", label: BACKGROUND_DOC_LABELS.POLICE_VERIFICATION, required: true },
          { docType: "CHARACTER_CERTIFICATE", label: BACKGROUND_DOC_LABELS.CHARACTER_CERTIFICATE, required: rule.requireCharacterCertificate },
        ]}
        maxBytes={rule.maxDocumentBytes}
      />
      <div className="mt-6 flex flex-wrap gap-2">
        <LinkButton href="/delivery-partner">Back to my application</LinkButton>
        <LinkButton href="/delivery-partner/kyc" variant="secondary">
          PAN and Aadhaar
        </LinkButton>
      </div>
    </div>
  );
}
