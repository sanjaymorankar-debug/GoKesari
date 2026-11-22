import { redirect } from "next/navigation";

import { ShopDocumentRulesAdmin } from "@/components/shop-document-rules-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getDocumentRulesAdmin } from "@/server/services/shop-document-rules";

export const metadata = { title: "Shop documents" };
export const dynamic = "force-dynamic";

/**
 * Shop documents (owner, 22-Nov-2026, DF-09): which licences and legal documents each kind of shop
 * needs, and documents the law newly requires. Admin edits; operators see it.
 */
export default async function ShopDocumentsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "OPERATOR" && user.role !== "ADMIN") redirect("/");
  const view = await getDocumentRulesAdmin();

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Shop documents"
        description="Which licences and legal documents each kind of shop needs: must-have before going live, upload later on the owner's promise, or optional. Add a document when a law starts requiring it."
      />
      <ShopDocumentRulesAdmin isAdmin={user.role === "ADMIN"} initial={view} />
    </div>
  );
}
