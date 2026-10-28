"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Card } from "@/components/ui";
import { DEALER_DOC_LABELS, DEALER_DOC_TYPES, DEALER_TYPE_LABELS, DEALER_TYPES, type DealerDocType, type DealerType } from "@/lib/dealers";

/**
 * Which documents each dealer type must upload (docs/dealer-programme,
 * GKS-DR-002). Admin ticks; operators see it read-only. Applies to
 * applications from now on; every change is audited.
 */
export function DocRequirementsAdmin({ isAdmin, requirements }: { isAdmin: boolean; requirements: { dealerType: DealerType; docType: DealerDocType; required: boolean }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRequired = (t: DealerType, d: DealerDocType) => requirements.find((r) => r.dealerType === t && r.docType === d)?.required ?? false;

  async function toggle(dealerType: DealerType, docType: DealerDocType, required: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/dealer-document-requirements", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ dealerType, docType, required }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2 p-4" data-testid="doc-requirements">
      <h2 className="text-base font-bold text-ink-900">Documents each dealer type must upload</h2>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink-500">
              <th className="p-1">Document</th>
              {DEALER_TYPES.map((t) => (
                <th key={t} className="p-1">
                  {DEALER_TYPE_LABELS[t]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DEALER_DOC_TYPES.map((d) => (
              <tr key={d} className="border-t border-cream-200">
                <td className="p-1">{DEALER_DOC_LABELS[d]}</td>
                {DEALER_TYPES.map((t) => (
                  <td key={t} className="p-1">
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      aria-label={`${DEALER_DOC_LABELS[d]} required for ${DEALER_TYPE_LABELS[t]}`}
                      checked={isRequired(t, d)}
                      disabled={!isAdmin || busy}
                      onChange={(e) => toggle(t, d, e.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-500">Ticked = required. Changes apply to applications submitted from now on and are logged.</p>
    </Card>
  );
}
