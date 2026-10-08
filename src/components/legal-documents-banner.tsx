import Link from "next/link";

import { Alert } from "@/components/ui";
import type { ShopLegalStatus } from "@/server/services/legal-documents";

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/**
 * Shop dashboard prompt (docs/four-features-2026-10, feature 2): what is
 * missing and by when, or that orders are blocked. Nothing when all is in order.
 */
export function LegalDocumentsBanner({ status }: { status: ShopLegalStatus }) {
  if (!status.enabled || status.documents.length === 0) return null;
  const blocking = status.documents.filter((d) => d.blocking);
  const pending = status.documents.filter((d) => !d.blocking && d.deadline);
  const expiring = status.documents.filter((d) => d.expiringSoon);
  const link = (
    <Link href="/shop/legal-documents" className="font-medium underline">
      Upload now
    </Link>
  );
  if (blocking.length > 0) {
    return (
      <div className="mb-4" data-testid="legal-documents-banner">
        <Alert tone="danger" title="Your shop cannot accept orders">
          {blocking.map((d) => d.label).join(", ")} {blocking.length === 1 ? "is" : "are"} required. {link}
        </Alert>
      </div>
    );
  }
  if (pending.length > 0) {
    return (
      <div className="mb-4" data-testid="legal-documents-banner">
        <Alert tone="warning" title={`Upload your ${pending.map((d) => d.label).join(", ")}`}>
          Required for your shop. Keep taking orders until {dateLabel(status.graceUntil ?? pending[0].deadline!)}; after that orders
          stop until {pending.length === 1 ? "it is" : "they are"} uploaded. {link}
        </Alert>
      </div>
    );
  }
  if (expiring.length > 0) {
    return (
      <div className="mb-4" data-testid="legal-documents-banner">
        <Alert tone="warning" title="A licence expires soon">
          {expiring.map((d) => `${d.label} expires ${d.expiryDate ? dateLabel(`${d.expiryDate}T00:00:00+05:30`) : "soon"}`).join("; ")}. Upload the renewed licence. {link}
        </Alert>
      </div>
    );
  }
  return null;
}
