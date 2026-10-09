import { Alert, Badge, Card } from "@/components/ui";
import type { ComplianceItem } from "@/server/services/compliance";

const STATUS_TONE = {
  ACTIVE: "success",
  MISSING: "danger",
  REVIEW_REQUIRED: "warning",
} as const;

const STATUS_LABEL = {
  ACTIVE: "Active",
  MISSING: "Missing",
  REVIEW_REQUIRED: "Review required",
} as const;

/**
 * Deliberately never prints "COMPLIANT" — ACTIVE means "the technical
 * control exists", not "a lawyer has confirmed this satisfies the law".
 */
export function ComplianceDashboard({ items }: { items: ComplianceItem[] }) {
  const missing = items.filter((i) => i.status === "MISSING").length;
  const review = items.filter((i) => i.status === "REVIEW_REQUIRED").length;

  return (
    <div className="space-y-4">
      <Alert tone="warning" title="Not a legal compliance certification">
        This dashboard shows which technical controls exist. It is not a
        substitute for review by an Indian lawyer or compliance
        professional, and this platform should not be described as
        &quot;legally compliant&quot; on the basis of this list alone.
      </Alert>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-ink-500">Active</p>
          <p className="mt-1 text-2xl font-bold text-leaf-700">
            {items.filter((i) => i.status === "ACTIVE").length}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Missing</p>
          <p className={`mt-1 text-2xl font-bold ${missing > 0 ? "text-red-600" : "text-ink-900"}`}>
            {missing}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Review required</p>
          <p className={`mt-1 text-2xl font-bold ${review > 0 ? "text-amber-800" : "text-ink-900"}`}>
            {review}
          </p>
        </Card>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-cream-100 text-xs uppercase text-ink-500">
            <tr>
              <th className="px-4 py-2">Area</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {items.map((item) => (
              <tr key={item.area}>
                <td className="px-4 py-2 font-medium text-ink-900">{item.area}</td>
                <td className="px-4 py-2">
                  <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                </td>
                <td className="px-4 py-2 text-ink-600">{item.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
