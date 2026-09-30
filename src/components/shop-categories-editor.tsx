"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ShopCategoryPicker, type PickerCategory } from "@/components/shop-category-picker";
import { Alert, Button, Card } from "@/components/ui";

/** Add, remove or change a shop's categories. Only the category mapping changes — products and orders are untouched. */
export function ShopCategoriesEditor({
  shopId,
  current,
  title = "Shop categories",
}: {
  shopId: string;
  current: PickerCategory[];
  title?: string;
}) {
  const router = useRouter();
  const [ids, setIds] = useState(current.map((c) => c.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setError(null);
    setSaved(false);
    if (ids.length === 0) return setError("Please select at least one shop category.");
    setBusy(true);
    const res = await fetch(`/api/shops/${shopId}/categories`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryIds: ids }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
      return setError(fields ? Object.values(fields).join(" ") : (payload?.error?.message ?? "Could not save the categories."));
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <Card className="space-y-3 p-4" data-testid="shop-categories-editor">
      <div>
        <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
        <p className="text-sm text-ink-500">
          What kind of business this shop runs. Customers search for products — these help us match and group shops.
        </p>
      </div>
      {current.length === 0 ? (
        <Alert tone="warning">No category is set for this shop yet. Please choose at least one.</Alert>
      ) : null}
      <ShopCategoryPicker value={ids} onChange={setIds} retained={current} />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {saved ? <Alert tone="success">Categories saved.</Alert> : null}
      <Button disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save categories"}
      </Button>
    </Card>
  );
}
