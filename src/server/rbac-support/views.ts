/** RBAC v2: turn change requests into what the owner and staff pages show (values as people read them, IST times). */
import type { ChangeRequestView } from "@/components/shop/pending-shop-changes";
import { staleItemIds, type OwnerChangeView } from "./change-requests";

const ist = (d: Date) =>
  d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function show(field: string, v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (field.endsWith("Paise")) return `₹${(Number(v) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (field === "addProduct" && typeof v === "object") {
    const p = v as { onlinePricePaise: number | null; offlinePricePaise: number | null };
    return [p.onlinePricePaise != null ? `online ${show("p.Paise", p.onlinePricePaise)}` : null, p.offlinePricePaise != null ? `in shop ${show("p.Paise", p.offlinePricePaise)}` : null]
      .filter(Boolean)
      .join(", ");
  }
  return String(v);
}

export async function toChangeViews(rows: OwnerChangeView[]): Promise<ChangeRequestView[]> {
  return Promise.all(
    rows.map(async (r) => {
      const stale = r.request.status === "PENDING" ? await staleItemIds(r.request.id) : new Set<string>();
      return {
        id: r.request.id,
        title: r.request.title,
        reason: r.request.reason,
        proposedBy: r.proposedByName,
        requestedAtIst: ist(r.request.requestedAt),
        expiresAtIst: r.request.expiresAt ? ist(r.request.expiresAt) : null,
        status: r.request.status,
        items: r.items.map((i) => ({
          id: i.id,
          label: i.label,
          productName: i.productName,
          previous: show(i.field, i.previousValue),
          proposed: show(i.field, i.proposedValue),
          status: i.status,
          rejectionComment: i.rejectionComment,
          stale: stale.has(i.id),
        })),
      };
    }),
  );
}
