import { Badge, Card } from "@/components/ui";

export interface FromShopDetails {
  shopName: string;
  legalName: string;
  contactName: string;
  mobileMasked: string | null;
  mobileVerified: boolean;
  email: string | null;
  emailVerified: boolean;
  panMasked: string | null;
  panVerified: boolean;
  gstin: string | null;
  gstVerified: boolean;
  address: { line1: string | null; city: string | null; pincode: string | null; state: string | null };
  bank: { holderName: string; accountMasked: string; ifsc: string } | null;
}

/**
 * Owner, 28-Nov-2026: a shop owner becoming a dealer / franchisee is not asked again for what his shop and account
 * already hold — shown read-only, each "from your shop" (verified where the shop verified it).
 */
export function FromShopDetailsCard({ details, note }: { details: FromShopDetails; note?: string }) {
  const rows: { label: string; value: string | null; verified?: boolean }[] = [
    { label: "Legal / business name", value: details.legalName },
    { label: "Owner name", value: details.contactName },
    { label: "Mobile", value: details.mobileMasked, verified: details.mobileVerified },
    { label: "E-mail", value: details.email, verified: details.emailVerified },
    { label: "PAN", value: details.panMasked, verified: details.panVerified },
    { label: "GSTIN", value: details.gstin, verified: details.gstVerified },
    { label: "Address", value: [details.address.line1, details.address.city, details.address.pincode, details.address.state].filter(Boolean).join(", ") || null },
    { label: "Payout bank account", value: details.bank ? `${details.bank.holderName} · ${details.bank.accountMasked} · ${details.bank.ifsc}` : null, verified: details.bank ? true : undefined },
  ];
  return (
    <Card className="space-y-2 p-4" data-testid="dealer-from-shop">
      <h2 className="text-base font-bold text-ink-900">Your details, from your shop {details.shopName}</h2>
      <p className="text-xs text-ink-600">{note ?? "Your shop account becomes your dealer account. Nothing here is typed again; to change it, change it on your shop."}</p>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        {rows
          .filter((r) => r.value)
          .map((r) => (
            <div key={r.label}>
              <dt className="text-ink-500">{r.label}</dt>
              <dd className="flex flex-wrap items-center gap-1 break-words">
                {r.value} <Badge tone="info">from your shop</Badge>
                {r.verified ? <Badge tone="success">verified</Badge> : null}
              </dd>
            </div>
          ))}
      </dl>
    </Card>
  );
}
