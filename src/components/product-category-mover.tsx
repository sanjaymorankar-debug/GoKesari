"use client";

/** Change one product's category from the product list (staff; owners for their own pending products). */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { postJson } from "@/components/save-changes-bar";
import { inputClass } from "@/components/ui";

export function ProductCategoryMover({
  productId,
  productName,
  categoryId,
  categories,
}: {
  productId: string;
  productName: string;
  categoryId: string;
  categories: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move(next: string) {
    const target = categories.find((c) => c.id === next);
    if (!target || next === categoryId) return;
    if (!window.confirm(`Move "${productName}" to ${target.name}? Shops that list it will start carrying ${target.name}.`)) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/products/${productId}/category`, "PATCH", { categoryId: next });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not move the product.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col">
      <select
        aria-label={`Category of ${productName}`}
        className={`${inputClass} py-1 text-xs`}
        value={categoryId}
        disabled={busy}
        onChange={(e) => move(e.target.value)}
      >
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {error ? <span className="mt-1 text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
