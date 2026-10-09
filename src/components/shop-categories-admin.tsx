"use client";

/**
 * Screen 1 — shop category management, with an explicit Save.
 *
 * Previously every control here wrote immediately: the rename row's Save was a
 * PATCH per click, and Activate/Deactivate was a PATCH on the button itself. A
 * category's name and status are now one local draft per row behind a single
 * Save Changes button, and the create form has its own.
 *
 * Reassigning a shop's categories is the third control on this screen; it lives
 * on `/admin/shops/[id]/categories` (`shop-categories-editor.tsx`) and uses the
 * same save bar.
 */

import { SectionTabs } from "@/components/board/section-tabs";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SaveChangesBar, postJson, useSaveChanges } from "@/components/save-changes-bar";
import { GuardedLink } from "@/components/unsaved-changes-guard";
import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

export interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  shopCount: number;
}
export interface UncategorisedShop {
  id: string;
  name: string;
  city: string;
  status: string;
  ownerName: string;
}

interface CategoryDraft {
  name: string;
  description: string;
  status: "ACTIVE" | "INACTIVE";
}

/** Operations view: create / rename / activate categories, see who uses each, and complete uncategorised shops. */
export function ShopCategoriesAdmin({
  categories,
  uncategorised,
}: {
  categories: CategoryRow[];
  uncategorised: UncategorisedShop[];
}) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(categories.length / CATEGORY_PAGE));
  const current = Math.min(page, pageCount);
  return (
    <SectionTabs
      label="Shop categories"
      labels={[`All categories (${categories.length})`, ...(uncategorised.length > 0 ? [`Shops with no category (${uncategorised.length})`] : []), "Add a category"]}
    >
      <section>
        <h2 className="sr-only">All categories</h2>
        <Card className="divide-y divide-cream-100">
          {categories.slice((current - 1) * CATEGORY_PAGE, current * CATEGORY_PAGE).map((c) => (
            <CategoryEditRow key={c.id} category={c} />
          ))}
        </Card>
        {pageCount > 1 ? (
          <nav aria-label="Pages" className="mt-3 flex items-center justify-between gap-2">
            <Button size="sm" variant="secondary" disabled={current <= 1} onClick={() => setPage(current - 1)}>
              ← Previous
            </Button>
            <span className="text-sm font-semibold text-ink-700">
              Page {current} of {pageCount}
            </span>
            <Button size="sm" variant="secondary" disabled={current >= pageCount} onClick={() => setPage(current + 1)}>
              Next →
            </Button>
          </nav>
        ) : null}
      </section>

      {uncategorised.length > 0 ? (
        <section data-testid="uncategorised">
          <h2 className="sr-only">Shops with no category</h2>
          <Card className="divide-y divide-cream-100">
            {uncategorised.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <span>
                  {s.name}{" "}
                  <span className="text-ink-500">
                    · {s.ownerName} · {s.city}
                  </span>{" "}
                  <Badge>{s.status.replace(/_/g, " ").toLowerCase()}</Badge>
                </span>
                <GuardedLink href={`/admin/shops/${s.id}/categories`} className="font-medium text-kesari-700 underline">
                  Assign categories
                </GuardedLink>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      <CreateCategory />
    </SectionTabs>
  );
}

/** Rows per page of the category list (each row holds its own edit form). */
const CATEGORY_PAGE = 8;

function CreateCategory() {
  const router = useRouter();
  const empty = { name: "", description: "" };
  const [draft, setDraft] = useState(empty);

  const trimmedName = draft.name.trim();
  const dirty = draft.name !== empty.name || draft.description !== empty.description;
  const clientError = dirty && trimmedName.length > 0 && trimmedName.length < 2 ? "A category name needs at least 2 characters." : null;

  const save = useSaveChanges({
    id: "category:new",
    dirty: dirty && trimmedName.length >= 2,
    onSave: async () => {
      await postJson("/api/shop-categories", "POST", {
        name: trimmedName,
        description: draft.description.trim() || null,
      });
      setDraft(empty);
      router.refresh();
      return `Category created: ${trimmedName}`;
    },
  });

  return (
    <section>
      <h2 className="sr-only">Add a category</h2>
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input
              className={inputClass}
              value={draft.name}
              maxLength={80}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </Field>
          <Field label="Description (optional)">
            <input
              className={inputClass}
              value={draft.description}
              maxLength={300}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            />
          </Field>
        </div>
        {clientError ? <Alert tone="danger">{clientError}</Alert> : null}
        <SaveChangesBar
          state={save}
          label="Save Changes"
          idleHint="Fill in a name to add a category."
          dirtyHint="Not added yet — press Save Changes."
          testId="category-create-save"
        />
      </Card>
    </section>
  );
}

function CategoryEditRow({ category }: { category: CategoryRow }) {
  const router = useRouter();
  const initial: CategoryDraft = {
    name: category.name,
    description: category.description ?? "",
    status: category.status === "ACTIVE" ? "ACTIVE" : "INACTIVE",
  };
  const [baseline, setBaseline] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [shops, setShops] = useState<{ id: string; name: string; city: string; status: string }[] | null>(null);
  const [shopsError, setShopsError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const trimmedName = draft.name.trim();
  const dirty =
    draft.name !== baseline.name || draft.description !== baseline.description || draft.status !== baseline.status;

  const clientError =
    trimmedName.length < 2 || trimmedName.length > 80 ? "A category name needs 2–80 characters." : null;

  const save = useSaveChanges({
    id: `category:${category.id}`,
    dirty: dirty && !clientError,
    // Deactivating hides a category from every picker, so that one is confirmed.
    confirm: () =>
      draft.status !== baseline.status && draft.status === "INACTIVE"
        ? {
            title: `Deactivate "${baseline.name}"?`,
            lines: [
              `Status: active → inactive`,
              `${category.shopCount} shop${category.shopCount === 1 ? "" : "s"} currently use it`,
            ],
            body: "Shops that already have this category keep it, but nobody can choose it for a shop any more.",
            confirmLabel: "Yes, deactivate",
          }
        : null,
    onSave: async () => {
      await postJson(`/api/shop-categories/${category.id}`, "PATCH", {
        name: trimmedName,
        description: draft.description.trim() || null,
        status: draft.status,
      });
      const settled = { ...draft, name: trimmedName };
      setBaseline(settled);
      setDraft(settled);
      setEditing(false);
      router.refresh();
      return describeCategoryChange(baseline, settled);
    },
  });

  async function toggleShops() {
    if (open) return setOpen(false);
    setOpen(true);
    if (shops) return;
    setShopsError(null);
    const res = await fetch(`/api/shop-categories/${category.id}`);
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      setShopsError(payload?.error?.message ?? "Could not load the shops using this category.");
      return;
    }
    setShops(payload.shops);
  }

  return (
    <div className="space-y-2 p-3 text-sm" data-testid="category-row">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-medium text-ink-900">{baseline.name}</span>{" "}
          <Badge tone={baseline.status === "ACTIVE" ? "success" : "neutral"}>{baseline.status.toLowerCase()}</Badge>
          {baseline.description ? <span className="ml-2 text-ink-500">{baseline.description}</span> : null}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <button type="button" className="text-sm text-kesari-700 underline" onClick={toggleShops}>
            {category.shopCount} shop{category.shopCount === 1 ? "" : "s"}
          </button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              if (editing && dirty && !window.confirm("Discard your unsaved changes to this category?")) return;
              if (editing) setDraft(baseline);
              setEditing(!editing);
            }}
          >
            {editing ? "Close" : "Rename / edit"}
          </Button>
        </span>
      </div>

      {editing ? (
        <div className="space-y-3 rounded-lg bg-cream-50 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input
                className={inputClass}
                value={draft.name}
                maxLength={80}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                aria-label="Category name"
              />
            </Field>
            <Field label="Description">
              <input
                className={inputClass}
                value={draft.description}
                maxLength={300}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                aria-label="Description"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={draft.status === "ACTIVE"}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.checked ? "ACTIVE" : "INACTIVE" }))}
            />
            Active — can be chosen for a shop
          </label>
          {clientError ? <Alert tone="danger">{clientError}</Alert> : null}
          <SaveChangesBar state={save} label="Save Changes" testId={`category-save-${category.id}`}>
            <Button variant="ghost" disabled={!dirty || save.busy} onClick={() => setDraft(baseline)}>
              Discard
            </Button>
          </SaveChangesBar>
        </div>
      ) : null}

      {open ? (
        <div className="rounded-lg bg-cream-50 p-2 text-xs text-ink-600">
          {shopsError ? <Alert tone="danger">{shopsError}</Alert> : null}
          <ul>
            {shops !== null && shops.length === 0 ? <li>No shops use this category.</li> : null}
            {(shops ?? []).map((s) => (
              <li key={s.id} className="flex justify-between gap-2 py-0.5">
                <span>
                  {s.name} · {s.city} · {s.status.replace(/_/g, " ").toLowerCase()}
                </span>
                <GuardedLink href={`/admin/shops/${s.id}/categories`} className="text-kesari-700 underline">
                  Edit shop categories
                </GuardedLink>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** "Category updated: Grocery → Daily Needs" — names the change, not just that one happened. */
function describeCategoryChange(before: CategoryDraft, after: CategoryDraft): string {
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`${before.name} → ${after.name}`);
  if (before.status !== after.status) parts.push(after.status === "ACTIVE" ? "activated" : "deactivated");
  if (before.description !== after.description) parts.push("description changed");
  return `Category updated: ${parts.length > 0 ? parts.join(", ") : after.name}`;
}
