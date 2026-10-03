"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, Button, Card, inputClass } from "@/components/ui";
import { rupeesToPaise } from "@/lib/money";

interface CatalogueProduct {
  id: string;
  name: string;
  code: string;
  unit: string;
  category: { id: string; name: string };
}

interface Category {
  id: string;
  name: string;
  isSystem?: boolean;
}

/**
 * "Add New Product" (product management brief).
 *
 * Two explicit paths, exactly as specified: pick something from the central
 * catalogue, or create something that doesn't exist yet. Both end up writing
 * the same two rows (`products` + `shop_products`) through the same backend —
 * this component is purely the two different ways of getting there.
 */
export function AddProductPanel({
  shopId,
  applyPriceImmediately,
}: {
  shopId: string;
  /** No longer used: what a shop can add comes from its categories, not its type. */
  department?: string;
  /** False for an operator acting on a shop they don't own — price queues for approval. */
  applyPriceImmediately: boolean;
}) {
  const [mode, setMode] = useState<"closed" | "existing" | "new">("closed");

  if (mode === "closed") {
    return (
      <Button onClick={() => setMode("existing")}>+ Add New Product</Button>
    );
  }

  return (
    <Card className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={mode === "existing" ? "primary" : "secondary"}
            onClick={() => setMode("existing")}
          >
            Add Existing Product
          </Button>
          <Button
            size="sm"
            variant={mode === "new" ? "primary" : "secondary"}
            onClick={() => setMode("new")}
          >
            Create New Product
          </Button>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setMode("closed")}>
          Close
        </Button>
      </div>

      {mode === "existing" ? (
        <ExistingProductSearch shopId={shopId} />
      ) : (
        <NewProductForm
          shopId={shopId}
          applyPriceImmediately={applyPriceImmediately}
          onCreated={() => setMode("closed")}
        />
      )}
    </Card>
  );
}

function ExistingProductSearch({ shopId }: { shopId: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogueProduct[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/shops/${shopId}/catalogue-search?q=${encodeURIComponent(query)}`,
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "Search failed.");
      setResults(payload.products);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Search products in this shop's categories…"
          className={inputClass}
        />
        <Button disabled={busy} onClick={search}>
          Search
        </Button>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {results !== null ? (
        results.length === 0 ? (
          <p className="text-sm text-ink-500">
            No matching products in the categories this shop carries. Add a
            category under &ldquo;Product categories&rdquo;, or try &ldquo;Create
            New Product&rdquo; instead.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {results.map((p) => (
              <ExistingResultRow key={p.id} shopId={shopId} product={p} />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function ExistingResultRow({
  shopId,
  product,
}: {
  shopId: string;
  product: CatalogueProduct;
}) {
  const router = useRouter();
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!price) {
      setError("Enter a price.");
      return;
    }
    setBusy(true);
    setError(null);
    const paise = rupeesToPaise(Number(price));
    const response = await fetch(`/api/shops/${shopId}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        onlineSaleEnabled: true,
        onlinePricePaise: paise,
        offlineSaleEnabled: true,
        offlinePricePaise: paise,
      }),
    });
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not add the product.");
      return;
    }
    router.refresh();
  }

  return (
    <Card className="p-3">
      <p className="truncate text-sm font-medium text-ink-900">{product.name}</p>
      <p className="text-xs text-ink-500">
        {product.category.name} · {product.code} · per {product.unit}
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          type="number"
          min={0}
          step={0.5}
          placeholder="₹"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className={`${inputClass} w-24`}
        />
        <Button size="sm" disabled={busy} onClick={add}>
          Add
        </Button>
      </div>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </Card>
  );
}

function NewProductForm({
  shopId,
  applyPriceImmediately,
  onCreated,
}: {
  shopId: string;
  applyPriceImmediately: boolean;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [specifications, setSpecifications] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [subCategory, setSubCategory] = useState("");
  const [unit, setUnit] = useState("");
  const [onlinePrice, setOnlinePrice] = useState("");
  const [offlinePrice, setOfflinePrice] = useState("");
  const [onlineEnabled, setOnlineEnabled] = useState(true);
  const [offlineEnabled, setOfflineEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [similarWarning, setSimilarWarning] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/product-categories?selectable=1")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const list: Category[] = data.categories ?? [];
        setCategories(list);
        // Category is required; General is the default when nothing else fits.
        setCategoryId((current) => current || list.find((c) => c.isSystem)?.id || "");
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (categories === null) {
    return <p className="text-sm text-ink-500">Loading categories…</p>;
  }

  async function submit(confirmDuplicate: boolean) {
    if (name.trim().length < 2) {
      setError("Product name must be at least 2 characters.");
      return;
    }
    if (!categoryId) {
      setError("Select a category.");
      return;
    }
    if (!unit.trim()) {
      setError("Enter a unit (e.g. L, kg, piece).");
      return;
    }
    if (onlineEnabled && !onlinePrice) {
      setError("Enter an online price, or turn off online selling.");
      return;
    }
    if (offlineEnabled && !offlinePrice) {
      setError("Enter an offline price, or turn off offline selling.");
      return;
    }

    setBusy(true);
    setError(null);
    setSimilarWarning(null);

    const response = await fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shopId,
        categoryId,
        name: name.trim(),
        description: description || null,
        specifications: specifications || null,
        subCategory: subCategory || null,
        unit: unit.trim(),
        onlineSaleEnabled: onlineEnabled,
        offlineSaleEnabled: offlineEnabled,
        onlinePricePaise: onlinePrice ? rupeesToPaise(Number(onlinePrice)) : null,
        offlinePricePaise: offlinePrice ? rupeesToPaise(Number(offlinePrice)) : null,
        confirmDuplicate,
      }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (response.status === 409 && !confirmDuplicate) {
      // The server's message lists the similar names; surface it as an
      // explicit "create anyway" step rather than a dead-end error.
      setSimilarWarning([payload?.error?.message ?? "A similar product exists."]);
      return;
    }
    if (!response.ok) {
      setError(payload?.error?.message ?? "Could not create the product.");
      return;
    }

    setNotice(
      payload.pendingPriceRequestId
        ? "Product created. The price was sent to the shop owner for approval."
        : payload.reusedExisting
          ? "An identical product already existed — it was added to your shop."
          : "Product created and added to your shop.",
    );
    router.refresh();
    setTimeout(onCreated, 1200);
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {similarWarning ? (
        <Alert tone="warning" title="This looks like a duplicate">
          {similarWarning[0]}
          <div className="mt-2">
            <Button size="sm" onClick={() => submit(true)}>
              Create anyway
            </Button>
          </div>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-ink-700 sm:col-span-2">
          Product name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Fresh Cow Milk"
            className={inputClass}
          />
        </label>

        <label className="text-sm text-ink-700 sm:col-span-2">
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Fresh farm milk supplied daily."
            rows={2}
            className={inputClass}
          />
        </label>

        <label className="text-sm text-ink-700 sm:col-span-2">
          Specifications
          <textarea
            value={specifications}
            onChange={(e) => setSpecifications(e.target.value)}
            placeholder={"Cow milk\n3.5% fat\n1 litre pack\nFresh daily"}
            rows={3}
            className={inputClass}
          />
        </label>

        <label className="text-sm text-ink-700">
          Category <span className="text-red-600">*</span>
          <select
            required
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className={inputClass}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-ink-500">
            The shop starts carrying this category if it does not already.
          </span>
        </label>
        <label className="text-sm text-ink-700">
          Sub-category (optional)
          <input
            value={subCategory}
            onChange={(e) => setSubCategory(e.target.value)}
            className={inputClass}
          />
        </label>

        <label className="text-sm text-ink-700">
          Unit / pack size
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="1 Litre"
            className={inputClass}
          />
        </label>
        <div />

        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={onlineEnabled}
            onChange={(e) => setOnlineEnabled(e.target.checked)}
          />
          Sell online
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={offlineEnabled}
            onChange={(e) => setOfflineEnabled(e.target.checked)}
          />
          Sell in shop
        </label>

        <label className="text-sm text-ink-700">
          Online price (₹)
          <input
            type="number"
            min={0}
            step={0.5}
            value={onlinePrice}
            onChange={(e) => setOnlinePrice(e.target.value)}
            disabled={!onlineEnabled}
            className={inputClass}
          />
        </label>
        <label className="text-sm text-ink-700">
          Offline price (₹)
          <input
            type="number"
            min={0}
            step={0.5}
            value={offlinePrice}
            onChange={(e) => setOfflinePrice(e.target.value)}
            disabled={!offlineEnabled}
            className={inputClass}
          />
        </label>
      </div>

      {!applyPriceImmediately ? (
        <p className="text-xs text-ink-500">
          You are creating this for a shop you don&apos;t own — the price will be
          sent to the shop owner for approval before it goes live.
        </p>
      ) : null}

      <Button disabled={busy} onClick={() => submit(false)}>
        {busy ? "Creating…" : "Create product"}
      </Button>
    </div>
  );
}
