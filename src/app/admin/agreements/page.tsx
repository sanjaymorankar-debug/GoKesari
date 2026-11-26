import { redirect } from "next/navigation";

import { AdminAgreements } from "@/components/agreements/admin-agreements";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";

export const metadata = { title: "Seller agreements" };
export const dynamic = "force-dynamic";

/**
 * Seller agreements (docs/seller-agreements-2026-11): agreement templates (upload, preview with a sample shop
 * in English / Marathi / Hindi, publish, retire), the signed acceptance record (filters, signed PDFs, CSV,
 * resend), the shops still to sign, and the company e-seal. Admins edit; operators with CONSENT_VIEW read and resend.
 */
export default async function AdminAgreementsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.CONSENT_VIEW)) redirect("/admin");
  return (
    <div className="space-y-4">
      <PageHeader
        title="Seller agreements"
        description="Personalised Seller SLA and Medical Onboarding Agreement, signed by shop owners with an OTP. All times in IST."
      />
      <AdminAgreements />
    </div>
  );
}
