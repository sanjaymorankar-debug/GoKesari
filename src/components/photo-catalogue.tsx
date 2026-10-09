"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { shrinkImage } from "@/components/image-uploader";
import { SafeImage } from "@/components/safe-image";
import { Alert, AvailabilityBadge, Badge, Button, Card, EmptyState, Money, inputClass } from "@/components/ui";
import { paiseToRupees } from "@/lib/money";
import { buildPricePatch, needsPhoto, needsPrice, tagPrice } from "@/lib/photo-catalogue";
import type { ShopCatalogueTile } from "@/server/services/product-images";

type Filter = "all" | "photo" | "price" | "pending";

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * The shop owner's photo catalogue: every listing as a photo with its price on
 * it, as customers see them. A photo is added or changed, and a price set,
 * right on the tile; the full photo manager stays one link away.
 */
export function PhotoCatalogue({ tiles, shopId }: { tiles: ShopCatalogueTile[]; shopId: string }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const categories = Array.from(new Set(tiles.map((t) => t.categoryName)));
  const counts: Record<Filter, number> = {
    all: tiles.length,
    photo: tiles.filter(needsPhoto).length,
    price: tiles.filter(needsPrice).length,
    pending: tiles.filter((t) => t.pendingCount > 0).length,
  };
  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "photo", label: "Needs a photo" },
    { key: "price", label: "Needs a price" },
    ...(counts.pending > 0 || filter === "pending" ? [{ key: "pending" as const, label: "Awaiting approval" }] : []),
  ];

  const term = query.trim().toLowerCase();
  const shown = tiles.filter((t) => {
    if (filter === "photo" && !needsPhoto(t)) return false;
    if (filter === "price" && !needsPrice(t)) return false;
    if (filter === "pending" && t.pendingCount === 0) return false;
    if (category && t.categoryName !== category) return false;
    if (term && !t.productName.toLowerCase().includes(term)) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search my products"
          aria-label="Search my products"
          className={`${inputClass} max-w-xs`}
        />
        {categories.length > 1 ? (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Category"
            className={`${inputClass} max-w-[200px]`}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            aria-pressed={filter === chip.key}
            onClick={() => setFilter(chip.key)}
            className={
              filter === chip.key
                ? "rounded-full bg-kesari-600 px-3 py-1 text-sm font-medium text-white"
                : "rounded-full border border-cream-200 bg-white px-3 py-1 text-sm font-medium text-ink-700 hover:bg-cream-100"
            }
            data-testid={`catalogue-filter-${chip.key}`}
          >
            {chip.label} ({counts[chip.key]})
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title={filter === "photo" ? "Every product has a photo." : filter === "price" ? "Every product has a price." : "No products match."}
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="catalogue-grid">
          {shown.map((tile) => (
            <CatalogueTile key={tile.shopProductId} tile={tile} shopId={shopId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CatalogueTile({ tile, shopId }: { tile: ShopCatalogueTile; shopId: string }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"photo" | "price" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [online, setOnline] = useState("");
  const [offline, setOffline] = useState("");

  const own = tile.ownPrimary;
  // The owner sees their own photo while it is under review (or turned down);
  // otherwise the tile shows exactly the photo customers see.
  const reviewing = own && own.moderationStatus !== "APPROVED" ? own : null;
  const tag = tagPrice(tile);
  const inShopDiffers =
    tile.onlinePricePaise != null && tile.offlinePricePaise != null && tile.offlinePricePaise !== tile.onlinePricePaise;

  async function showFailure(res: Response, fallback: string) {
    const payload = await res.json().catch(() => null);
    setError(payload?.error?.message ?? fallback);
  }

  async function uploadPhoto(files: FileList | null) {
    const file = files?.[0];
    if (fileInput.current) fileInput.current.value = "";
    if (!file) return;
    setBusy("photo");
    setError(null);
    setNotice(null);
    try {
      // Module 1: the shop-photo pipeline (EXIF removed, WebP sizes). A listing
      // with its own main photo has it swapped; otherwise this becomes its first.
      const form = new FormData();
      form.append("file", await shrinkImage(file), file.name);
      if (own) form.append("replaceImageId", own.id);
      const res = await fetch(`/api/shops/${shopId}/listings/${tile.shopProductId}/media/photos`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        await showFailure(res, "Could not save the photo.");
        return;
      }
      const saved = await res.json().catch(() => null);
      if (saved?.moderationStatus === "PENDING") {
        setNotice("Photo sent for approval. Customers see it once GoKesari approves it.");
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not upload the photo.");
    } finally {
      setBusy(null);
    }
  }

  function startEditing() {
    setOnline(tile.onlinePricePaise != null ? String(paiseToRupees(tile.onlinePricePaise)) : "");
    setOffline(tile.offlinePricePaise != null ? String(paiseToRupees(tile.offlinePricePaise)) : "");
    setError(null);
    setNotice(null);
    setEditing(true);
  }

  async function savePrice() {
    const result = buildPricePatch(tile, { online, offline });
    if ("error" in result) {
      setError(result.error);
      return;
    }
    if (Object.keys(result.patch).length === 0) {
      setEditing(false);
      return;
    }
    setBusy("price");
    setError(null);
    try {
      const res = await fetch(`/api/shop-products/${tile.shopProductId}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(result.patch),
      });
      if (!res.ok) {
        await showFailure(res, "Could not save the price.");
        return;
      }
      const payload = await res.json().catch(() => null);
      if (payload?.pendingApproval) setNotice(payload.message);
      setEditing(false);
      router.refresh();
    } catch {
      setError("Could not save the price.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li data-testid="catalogue-tile">
      <Card className="flex h-full flex-col overflow-hidden">
        <div className="relative">
          <SafeImage
            src={reviewing ? reviewing.url : tile.liveImageUrl}
            alt={tile.productName}
            className="aspect-square w-full bg-cream-100 object-cover"
          />
          <div className="absolute left-2 top-2 flex flex-wrap gap-1">
            {reviewing?.moderationStatus === "PENDING" ? <Badge tone="warning">Awaiting approval</Badge> : null}
            {reviewing?.moderationStatus === "REJECTED" ? <Badge tone="danger">Not approved</Badge> : null}
            {!reviewing && tile.liveImageSource === "PRODUCT" ? <Badge>Catalogue photo</Badge> : null}
            {!reviewing && !tile.liveImageUrl ? <Badge tone="warning">No photo</Badge> : null}
          </div>
          <div className="absolute bottom-2 left-2" data-testid="catalogue-price-tag">
            {tag ? (
              <span className="rounded-md bg-white/95 px-2 py-1 text-sm font-semibold text-ink-900 shadow">
                <Money paise={tag.pricePaise} />
                <span className="text-xs font-normal text-ink-500"> / {tile.unit}</span>
              </span>
            ) : (
              <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800 shadow">
                No price
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-2 p-3">
          <div>
            <p className="line-clamp-2 text-sm font-medium text-ink-900">{tile.productName}</p>
            <p className="text-xs text-ink-500">
              {tile.categoryName} · per {tile.unit}
            </p>
            {tag && tag.channel === "in shop" ? <p className="text-xs text-ink-500">In-shop price</p> : null}
            {inShopDiffers ? (
              <p className="text-xs text-ink-500">
                In shop <Money paise={tile.offlinePricePaise as number} />
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1">
            <AvailabilityBadge
              onlineSaleEnabled={tile.onlineSaleEnabled}
              offlineSaleEnabled={tile.offlineSaleEnabled}
              isAvailable={tile.isAvailable}
              outOfStock={tile.trackInventory && tile.onlineStock <= 0}
            />
          </div>
          {tile.paused ? (
            <p className="text-xs font-medium text-amber-700">Paused — your shop no longer carries {tile.categoryName}.</p>
          ) : null}
          {reviewing?.moderationStatus === "REJECTED" && reviewing.rejectionReason ? (
            <p className="text-xs text-red-700">Photo not approved: {reviewing.rejectionReason}</p>
          ) : null}

          {editing ? (
            <div className="space-y-2 border-t border-cream-200 pt-2">
              <label className="block text-xs text-ink-700">
                Online price (₹ per {tile.unit})
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  inputMode="decimal"
                  value={online}
                  onChange={(e) => setOnline(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="block text-xs text-ink-700">
                In-shop price (₹ per {tile.unit})
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  inputMode="decimal"
                  value={offline}
                  onChange={(e) => setOffline(e.target.value)}
                  className={inputClass}
                />
              </label>
              <div className="flex gap-1">
                <Button size="sm" disabled={busy !== null} onClick={savePrice}>
                  {busy === "price" ? "Saving…" : "Save price"}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          <div className="mt-auto flex flex-wrap gap-1 pt-1">
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
              {busy === "photo" ? "Uploading…" : own ? "Change photo" : "Add photo"}
            </Button>
            {!editing ? (
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={startEditing}>
                {tag ? "Edit price" : "Set price"}
              </Button>
            ) : null}
          </div>
          <Link
            href={`/shop/products/${tile.shopProductId}/media`}
            className="text-xs font-medium text-kesari-700 hover:underline"
            aria-label={`Photos and description of ${tile.productName}`}
          >
            Photos &amp; description{tile.ownPhotoCount > 0 ? ` (${tile.ownPhotoCount})` : ""} →
          </Link>
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(e) => void uploadPhoto(e.target.files)}
          />
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}
        </div>
      </Card>
    </li>
  );
}
