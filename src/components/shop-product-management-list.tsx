"use client";

import Link from "next/link";
import { useState } from "react";

import { ShopSuspensionControls } from "@/components/shop-suspension-controls";
import { Badge, Card, ClassificationBadge, EmptyState, StatusBadge, inputClass } from "@/components/ui";

export interface ShopListRow {
  id: string;
  registrationNumber: string;
  name: string;
  ownerName: string;
  shopType: string;
  classification: "KESARI" | "GREEN" | null;
  status: string;
  productCount: number;
}

/**
 * Admin "Shop Product Management" — select a shop (product management brief).
 *
 * Search/filter is client-side over a single fetched list. The shop count in
 * this marketplace is in the hundreds at most, so a second round-trip per
 * keystroke would be pure overhead — everything the operator needs is already
 * on the page.
 */
export function ShopProductManagementList({ shops, canSuspend = false }: { shops: ShopListRow[]; canSuspend?: boolean }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");

  const filtered = shops.filter((s) => {
    if (status && s.status !== status) return false;
    if (query) {
      const term = query.toLowerCase();
      const haystack = [s.name, s.ownerName, s.registrationNumber].join(" ").toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });

  const statuses = Array.from(new Set(shops.map((s) => s.status)));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shop, owner or registration number"
          className={`${inputClass} max-w-xs`}
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className={`${inputClass} max-w-[160px]`}
        >
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <span className="flex items-center text-sm text-ink-500">
          {filtered.length} shop{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No shops match those filters." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-cream-100 text-xs uppercase text-ink-500">
              <tr>
                <th className="px-4 py-2">Reg. no.</th>
                <th className="px-4 py-2">Shop</th>
                <th className="px-4 py-2">Owner</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Classification</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Products</th>
                <th className="px-4 py-2" />
                {canSuspend ? <th className="px-4 py-2" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2 font-medium text-ink-900">
                    {s.registrationNumber}
                  </td>
                  <td className="px-4 py-2 text-ink-900">{s.name}</td>
                  <td className="px-4 py-2">{s.ownerName}</td>
                  <td className="px-4 py-2">
                    <Badge>{s.shopType.replace(/_/g, " ")}</Badge>
                  </td>
                  <td className="px-4 py-2">
                    <ClassificationBadge value={s.classification} />
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-4 py-2">{s.productCount}</td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/admin/shops/${s.id}/products`}
                      className="text-sm font-medium text-kesari-600 hover:underline"
                    >
                      Manage products →
                    </Link>
                  </td>
                  {canSuspend ? (
                    <td className="px-4 py-2 align-top">
                      <ShopSuspensionControls shopId={s.id} shopName={s.name} status={s.status} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
