"use client";

/**
 * Screen 1, reassign half — move a shop between categories, with an explicit
 * Save.
 *
 * This already had a Save button, but it had no notion of "unchanged": the
 * button was always live, a success banner never cleared, and leaving with
 * edits in the picker lost them silently. It now shares `SaveChangesBar` with
 * the rest of the admin save screens, so the button is dead until something
 * changes, the confirmation names the categories added and removed, and a
 * half-finished edit warns before the page is left.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { SaveChangesBar, postJson, useSaveChanges } from "@/components/save-changes-bar";
import { ShopCategoryPicker, type PickerCategory } from "@/components/shop-category-picker";
import { Alert, Card } from "@/components/ui";

export function ShopCategoriesEditor({
  shopId,
  shopName,
  current,
  title = "Shop categories",
}: {
  shopId: string;
  shopName?: string;
  current: PickerCategory[];
  title?: string;
}) {
  const router = useRouter();
  const [baseline, setBaseline] = useState<string[]>(current.map((c) => c.id));
  const [ids, setIds] = useState<string[]>(baseline);

  const sameSet = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
  const dirty = !sameSet(ids, baseline);

  const clientError = ids.length === 0 ? "Please select at least one shop category." : null;

  const save = useSaveChanges({
    id: `shop-categories:${shopId}`,
    dirty: dirty && !clientError,
    onSave: async () => {
      const result = await postJson<{ added: string[]; removed: string[] }>(
        `/api/shops/${shopId}/categories`,
        "PUT",
        { categoryIds: ids },
      );
      setBaseline(ids);
      router.refresh();
      const changes = [...result.added.map((n) => `+${n}`), ...result.removed.map((n) => `−${n}`)];
      const subject = shopName ? `Categories updated for ${shopName}` : "Categories updated";
      return changes.length > 0 ? `${subject}: ${changes.join(", ")}` : subject;
    },
  });

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
      {clientError && dirty ? <Alert tone="danger">{clientError}</Alert> : null}
      <SaveChangesBar
        state={save}
        label="Save Changes"
        dirtyHint="Unsaved category changes — nothing is written yet."
        testId="shop-categories-save"
      />
    </Card>
  );
}
