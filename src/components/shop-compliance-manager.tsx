"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";
import { isFoodBusinessShopType, shopTypeLabel } from "@/lib/shop-types";

export interface ComplianceShopRow {
  id: string;
  name: string;
  shopType: string;
  city: string;
  legalBusinessName: string | null;
  gstin: string | null;
  fssaiLicenseNumber: string | null;
  returnPolicyText: string | null;
}

/**
 * GSTIN/FSSAI/legal-name are verifiable regulatory credentials, so they are
 * only editable by admin/operator here — not by the shop owner's own
 * settings form (Part 58).
 */
export function ShopComplianceManager({ shops }: { shops: ComplianceShopRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
  const [openFor, setOpenFor] = useState<string | null>(null);

  const isMissing = (s: ComplianceShopRow) =>
    !s.legalBusinessName || (isFoodBusinessShopType(s.shopType) && !s.fssaiLicenseNumber);

  const filtered = shops.filter((s) => {
    if (missingOnly && !isMissing(s)) return false;
    if (query) {
      const term = query.toLowerCase();
      if (!`${s.name} ${s.city}`.toLowerCase().includes(term)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-ink-500">Search</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Shop or city"
              className={inputClass}
            />
          </label>
          <label className="flex items-end gap-2 pb-2">
            <input
              type="checkbox"
              checked={missingOnly}
              onChange={(e) => setMissingOnly(e.target.checked)}
              className="h-4 w-4 accent-kesari-600"
            />
            <span className="text-sm text-ink-700">Missing required info only</span>
          </label>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState title="No shops match those filters." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-cream-100 text-xs uppercase text-ink-500">
              <tr>
                <th className="px-4 py-2">Shop</th>
                <th className="px-4 py-2">Legal name</th>
                <th className="px-4 py-2">GSTIN</th>
                <th className="px-4 py-2">FSSAI</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {filtered.map((s) => {
                const foodBusiness = isFoodBusinessShopType(s.shopType);
                return (
                  <>
                    <tr key={s.id}>
                      <td className="px-4 py-2">
                        <span className="font-medium text-ink-900">{s.name}</span>
                        <p className="text-xs text-ink-500">
                          {shopTypeLabel(s.shopType)} · {s.city}
                        </p>
                      </td>
                      <td className="px-4 py-2">
                        {s.legalBusinessName || <Badge tone="warning">Missing</Badge>}
                      </td>
                      <td className="px-4 py-2">{s.gstin || "—"}</td>
                      <td className="px-4 py-2">
                        {!foodBusiness ? (
                          <span className="text-ink-500">N/A</span>
                        ) : s.fssaiLicenseNumber ? (
                          s.fssaiLicenseNumber
                        ) : (
                          <Badge tone="warning">Missing</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setOpenFor(openFor === s.id ? null : s.id)}
                        >
                          {openFor === s.id ? "Close" : "Edit"}
                        </Button>
                      </td>
                    </tr>
                    {openFor === s.id ? (
                      <tr key={`${s.id}-edit`}>
                        <td colSpan={5} className="bg-cream-50 px-4 py-4">
                          <ComplianceEditForm
                            shop={s}
                            foodBusiness={foodBusiness}
                            onSaved={() => {
                              setOpenFor(null);
                              router.refresh();
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function ComplianceEditForm({
  shop,
  foodBusiness,
  onSaved,
}: {
  shop: ComplianceShopRow;
  foodBusiness: boolean;
  onSaved: () => void;
}) {
  const [legalBusinessName, setLegalBusinessName] = useState(shop.legalBusinessName ?? "");
  const [gstin, setGstin] = useState(shop.gstin ?? "");
  const [fssaiLicenseNumber, setFssaiLicenseNumber] = useState(shop.fssaiLicenseNumber ?? "");
  const [returnPolicyText, setReturnPolicyText] = useState(shop.returnPolicyText ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/shops/${shop.id}/compliance`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legalBusinessName: legalBusinessName.trim() || null,
        gstin: gstin.trim() || null,
        fssaiLicenseNumber: fssaiLicenseNumber.trim() || null,
        returnPolicyText: returnPolicyText.trim() || null,
      }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setError(payload?.error?.message ?? "Could not save.");
      return;
    }
    onSaved();
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {error ? (
        <div className="sm:col-span-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      <label className="block">
        <span className="text-xs text-ink-500">Legal business name</span>
        <input
          className={inputClass}
          value={legalBusinessName}
          onChange={(e) => setLegalBusinessName(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-xs text-ink-500">GSTIN</span>
        <input
          className={inputClass}
          value={gstin}
          onChange={(e) => setGstin(e.target.value.toUpperCase())}
          maxLength={15}
        />
      </label>
      <label className="block">
        <span className="text-xs text-ink-500">
          FSSAI licence number{!foodBusiness ? " (not required for this shop type)" : ""}
        </span>
        <input
          className={inputClass}
          value={fssaiLicenseNumber}
          onChange={(e) => setFssaiLicenseNumber(e.target.value)}
        />
      </label>
      <label className="block sm:col-span-2">
        <span className="text-xs text-ink-500">
          Shop-specific return policy (shown to customers instead of the platform default)
        </span>
        <textarea
          className={inputClass}
          rows={2}
          value={returnPolicyText}
          onChange={(e) => setReturnPolicyText(e.target.value)}
        />
      </label>
      <div className="sm:col-span-2">
        <Button onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
