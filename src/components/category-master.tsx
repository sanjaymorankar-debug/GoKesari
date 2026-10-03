"use client";

/**
 * Category Master: add, edit and remove product categories.
 *
 * Every control here is also enforced on the server — the buttons a role does
 * not get are hidden only to keep the screen honest. Removing a category always
 * goes through a confirmation that names what it affects (products moving to
 * General, shops losing the category, listings that would pause).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { postJson } from "@/components/save-changes-bar";
import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { SHOP_TYPES } from "@/lib/shop-types";

export interface CategoryMasterItem {
  id: string;
  name: string;
  description: string | null;
  department: string;
  isActive: boolean;
  isSystem: boolean;
  createdBy: string | null;
  createdByName: string | null;
  /** Already formatted on the server, so server and browser render the same text. */
  createdAt: string;
  productCount: number;
  shopCount: number;
}

interface Impact {
  categoryName: string;
  productCount: number;
  shopCount: number;
  listingsAtRisk: number;
  shopsNeedingGeneral: number;
}

const aisleLabel = (key: string) => SHOP_TYPES.find((t) => t.key === key)?.label ?? key;

export function CategoryMaster({
  categories,
  actorId,
  canManageAny,
}: {
  categories: CategoryMasterItem[];
  actorId: string;
  canManageAny: boolean;
}) {
  return (
    <div className="space-y-8">
      <AddCategory />
      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Categories ({categories.length})</h2>
        <Card className="divide-y divide-cream-100" data-testid="category-list">
          {categories.map((c) => (
            <CategoryRow
              key={c.id}
              category={c}
              // Shop owners: only what they created. The server also refuses a
              // category another owner's shop now carries.
              canManage={!c.isSystem && (canManageAny || c.createdBy === actorId)}
            />
          ))}
        </Card>
      </section>
    </div>
  );
}

function AddCategory() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [department, setDepartment] = useState("GENERAL_TRADING");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function submit() {
    if (name.trim().length < 2) {
      setMessage({ tone: "danger", text: "A category name needs at least 2 characters." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await postJson("/api/product-categories", "POST", {
        name: name.trim(),
        description: description.trim() || null,
        department,
      });
      setMessage({ tone: "success", text: `Category added: ${name.trim()}` });
      setName("");
      setDescription("");
      router.refresh();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Could not add the category." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold text-ink-900">Add a category</h2>
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name">
            <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description (optional)">
            <input className={inputClass} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Customer aisle" hint="Where customers find these products when browsing.">
            <select className={inputClass} value={department} onChange={(e) => setDepartment(e.target.value)}>
              {SHOP_TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        <Button disabled={busy} onClick={submit}>
          {busy ? "Adding…" : "Add category"}
        </Button>
      </Card>
    </section>
  );
}

function CategoryRow({ category, canManage }: { category: CategoryMasterItem; canManage: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "edit" | "remove">("view");
  const [name, setName] = useState(category.name);
  const [description, setDescription] = useState(category.description ?? "");
  const [impact, setImpact] = useState<Impact | null>(null);
  const [keepVisible, setKeepVisible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      await postJson(`/api/product-categories/${category.id}`, "PATCH", {
        name: name.trim(),
        description: description.trim() || null,
      });
      setMode("view");
      router.refresh();
    });

  const toggleActive = () =>
    run(async () => {
      await postJson(`/api/product-categories/${category.id}`, "PATCH", { isActive: !category.isActive });
      router.refresh();
    });

  const askRemove = () =>
    run(async () => {
      const response = await fetch(`/api/product-categories/${category.id}/impact`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not check what this affects.");
      setImpact(payload as Impact);
      setMode("remove");
    });

  const confirmRemove = () =>
    run(async () => {
      await postJson(`/api/product-categories/${category.id}?keepListingsVisible=${keepVisible ? "1" : "0"}`, "DELETE");
      router.refresh();
    });

  return (
    <div className="space-y-2 p-3 text-sm" data-testid={`category-${category.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span className="font-medium text-ink-900">{category.name}</span>{" "}
          {category.isSystem ? <Badge tone="info">Permanent</Badge> : null}{" "}
          {!category.isActive ? <Badge tone="warning">Inactive</Badge> : null}
          {category.description ? <p className="text-ink-500">{category.description}</p> : null}
          <p className="text-xs text-ink-500">
            {category.productCount} products · {category.shopCount} shops · aisle: {aisleLabel(category.department)} · added{" "}
            {category.createdAt}
            {category.createdByName ? ` by ${category.createdByName}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/product-categories/products?category=${category.id}`}
            className="rounded-md px-2 py-1 font-medium text-kesari-700 underline"
          >
            View products
          </Link>
          {canManage && mode === "view" ? (
            <>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setMode("edit")}>
                Edit
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={toggleActive}>
                {category.isActive ? "Deactivate" : "Activate"}
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={askRemove}>
                Remove
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {mode === "edit" ? (
        <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto_auto]">
          <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <input
            className={inputClass}
            value={description}
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
            aria-label="Description"
          />
          <Button size="sm" disabled={busy} onClick={save}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
            Cancel
          </Button>
        </div>
      ) : null}

      {mode === "remove" && impact ? (
        <Alert tone="warning" title={`Remove "${impact.categoryName}"?`}>
          <ul className="list-disc pl-5">
            <li>
              {impact.productCount} product{impact.productCount === 1 ? "" : "s"} will move to <strong>General</strong> — no
              product is deleted.
            </li>
            <li>
              It will be removed from {impact.shopCount} shop{impact.shopCount === 1 ? "" : "s"}.
            </li>
            {impact.listingsAtRisk > 0 ? (
              <li>
                {impact.listingsAtRisk} listing{impact.listingsAtRisk === 1 ? "" : "s"} in {impact.shopsNeedingGeneral} shop
                {impact.shopsNeedingGeneral === 1 ? "" : "s"} would pause, because those shops do not carry General.
              </li>
            ) : null}
            <li>Past orders and history are not affected.</li>
          </ul>
          {impact.listingsAtRisk > 0 ? (
            <label className="mt-2 flex items-center gap-2">
              <input type="checkbox" checked={keepVisible} onChange={(e) => setKeepVisible(e.target.checked)} />
              Add General to those shops so their listings stay on sale
            </label>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="danger" disabled={busy} onClick={confirmRemove}>
              {busy ? "Removing…" : "Yes, remove it"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
              Cancel
            </Button>
          </div>
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
