"use client";

/**
 * The categories one shop carries. Adding a category makes all of its products
 * visible to the shop at once (and every product added to it later); removing
 * one pauses the shop's listings in it after a confirmation that says how
 * many. Ownership is enforced on the server — an owner can only reach their
 * own shop here.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { postJson } from "@/components/save-changes-bar";
import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";

export interface AssignedCategory {
  categoryId: string;
  name: string;
  isActive: boolean;
  isSystem: boolean;
  productCount: number;
  /** Already formatted on the server. */
  addedAt: string;
  addedByName: string | null;
}

export function ShopProductCategoriesManager({
  shopId,
  assigned,
  selectable,
}: {
  shopId: string;
  assigned: AssignedCategory[];
  selectable: { id: string; name: string }[];
}) {
  const router = useRouter();
  const have = new Set(assigned.map((a) => a.categoryId));
  const addable = selectable.filter((c) => !have.has(c.id));
  const [toAdd, setToAdd] = useState("");
  const [confirming, setConfirming] = useState<{ categoryId: string; name: string; pausedListings: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function run(action: () => Promise<string | void>) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      if (text) setMessage({ tone: "success", text });
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      if (!toAdd) throw new Error("Choose a category to add.");
      const result = await postJson<{
        categoryName: string;
        addedProducts: number;
        needsPrice: { productName: string }[];
      }>(`/api/shops/${shopId}/product-categories`, "POST", { categoryId: toAdd });
      setToAdd("");
      router.refresh();
      if (result.addedProducts === 0) {
        return `Added ${result.categoryName}. Its products are now visible to this shop.`;
      }
      const needsPrice = result.needsPrice.length
        ? ` ${result.needsPrice.length} still need a price — enter it on the Inventory page.`
        : "";
      return `Added ${result.categoryName}: ${result.addedProducts} products added to the inventory with stock 100.${needsPrice}`;
    });

  const askRemove = (a: AssignedCategory) =>
    run(async () => {
      const response = await fetch(`/api/shops/${shopId}/product-categories/${a.categoryId}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not check what this affects.");
      setConfirming({ categoryId: a.categoryId, name: a.name, pausedListings: payload.pausedListings });
    });

  const confirmRemove = () =>
    run(async () => {
      if (!confirming) return;
      const result = await postJson<{ categoryName: string; pausedListings: number }>(
        `/api/shops/${shopId}/product-categories/${confirming.categoryId}`,
        "DELETE",
      );
      setConfirming(null);
      router.refresh();
      return `Removed ${result.categoryName}.${result.pausedListings ? ` ${result.pausedListings} listing(s) paused.` : ""}`;
    });

  return (
    <Card className="space-y-4 p-4" data-testid="shop-product-categories">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-56 flex-1 text-sm text-ink-700">
          Add a category
          <select className={inputClass} value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
            <option value="">Choose…</option>
            {addable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <Button disabled={busy || !toAdd} onClick={add}>
          Add
        </Button>
      </div>

      {assigned.length === 0 ? (
        <p className="text-sm text-ink-500">This shop carries no categories yet, so it sees no products to add.</p>
      ) : (
        <ul className="divide-y divide-cream-100 text-sm">
          {assigned.map((a) => (
            <li key={a.categoryId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium text-ink-900">{a.name}</span>{" "}
                {!a.isActive ? <Badge tone="warning">Inactive</Badge> : null}
                <span className="block text-xs text-ink-500">
                  {a.productCount} products · added {a.addedAt}
                  {a.addedByName ? ` by ${a.addedByName}` : ""}
                </span>
              </span>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => askRemove(a)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {confirming ? (
        <Alert tone="warning" title={`Remove ${confirming.name} from this shop?`}>
          Its products stop being visible to this shop.
          {confirming.pausedListings > 0
            ? ` ${confirming.pausedListings} of this shop's listings in it will pause (hidden from customers, not deleted) until the category is added back.`
            : " The shop has no listings in it."}{" "}
          Past orders are not affected.
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="danger" disabled={busy} onClick={confirmRemove}>
              Yes, remove
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </Alert>
      ) : null}

      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
    </Card>
  );
}
