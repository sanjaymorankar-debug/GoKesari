import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listUploadsForReview } from "@/server/services/document-uploads";

export const metadata = { title: "Document uploads" };
export const dynamic = "force-dynamic";

const FIELD_LABELS: Record<string, string> = {
  number: "Number",
  name: "Name",
  address: "Address",
  validFrom: "Valid from",
  validUntil: "Valid until",
};

/**
 * docs/document-upload-2026-10: every document a shop owner uploaded, what
 * the reader found and what the owner confirmed — with the fields the owner
 * changed highlighted. Decisions stay on Seller verification and Legal
 * documents; this page is for seeing the evidence. Opening a file is audited.
 */
export default async function DocumentUploadsPage({ searchParams }: { searchParams: Promise<{ flagged?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_GST_PAN_VERIFY)) redirect("/");
  const flaggedOnly = (await searchParams).flagged === "1";
  const uploads = await listUploadsForReview(user, { flaggedOnly });

  return (
    <div className="mx-auto max-w-5xl space-y-4" data-testid="admin-document-uploads">
      <PageHeader
        title="Document uploads"
        description="Documents shop owners uploaded or photographed: what was read automatically, what the owner confirmed, and any problems flagged. Approve or reject on Seller verification or Legal documents."
        action={
          <div className="flex gap-3 text-sm">
            <Link className="text-kesari-700 underline" href="/admin/seller-verification">Seller verification</Link>
            <Link className="text-kesari-700 underline" href="/admin/legal-documents">Legal documents</Link>
          </div>
        }
      />
      <nav className="flex gap-2 text-sm" aria-label="Filter">
        <Link href="/admin/document-uploads" className={!flaggedOnly ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1"}>All</Link>
        <Link href="/admin/document-uploads?flagged=1" className={flaggedOnly ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1"}>Flagged or corrected</Link>
      </nav>
      {uploads.length === 0 ? <p className="text-sm text-ink-600">No uploads.</p> : null}
      {uploads.map((u) => (
        <Card key={u.id} className="space-y-2 p-4 text-sm" data-testid="admin-upload-row">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-ink-900">
              {u.shopName} · {u.label}
            </p>
            <div className="flex flex-wrap gap-1">
              <Badge tone={u.status === "CONFIRMED" ? "success" : "info"}>{u.status === "CONFIRMED" ? "Submitted by owner" : "Read, not yet submitted"}</Badge>
              <Badge>{u.source === "CAMERA" ? "Photo" : "File"} · {u.readerEngine}{u.readerConfidence != null ? ` ${u.readerConfidence}%` : ""}</Badge>
            </div>
          </div>
          <p className="text-xs text-ink-500">Owner: {u.ownerName} · uploaded {u.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-ink-500">
                <th className="py-1 pr-2 font-medium">Field</th>
                <th className="py-1 pr-2 font-medium">Read from document</th>
                <th className="py-1 font-medium">Confirmed by owner</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(FIELD_LABELS).map(([key, label]) => {
                const read = (u.fields as Record<string, string | null> | null)?.[key] ?? null;
                const confirmed = (u.confirmed as Record<string, string | null> | null)?.[key] ?? null;
                const changed = u.fieldsCorrected.includes(key);
                return (
                  <tr key={key} className={changed ? "bg-amber-50" : undefined}>
                    <td className="py-1 pr-2 text-ink-600">{label}{changed ? " (changed by owner)" : ""}</td>
                    <td className="py-1 pr-2 font-mono">{read ?? "—"}</td>
                    <td className="py-1 font-mono">{u.status === "CONFIRMED" ? (confirmed ?? "—") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {u.flags.length ? (
            <ul className="list-disc pl-5 text-xs text-amber-900">
              {u.flags.map((f) => (
                <li key={f.code}>
                  <strong>{f.code}</strong>: {f.message}
                </li>
              ))}
            </ul>
          ) : null}
          {u.status === "EXTRACTED" ? (
            <a className="text-xs text-kesari-700 underline" href={`/api/shops/${u.shopId}/documents/${u.id}/file`} target="_blank" rel="noreferrer">
              Open the uploaded file
            </a>
          ) : (
            <p className="text-xs text-ink-500">The file is attached to the shop&apos;s {u.verificationId ? "seller verification" : "legal document"} record.</p>
          )}
        </Card>
      ))}
    </div>
  );
}
