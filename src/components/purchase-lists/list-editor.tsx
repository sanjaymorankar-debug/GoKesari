"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ConfirmButton } from "@/components/confirm-button";
import { Choice } from "@/components/purchase-lists/create-list-form";
import { SafeImage } from "@/components/safe-image";
import { Alert, Badge, Button, Card, Field, LinkButton, Money, inputClass } from "@/components/ui";
import { formatQuantity, lineTotalPaise } from "@/lib/money";
import {
  FREQUENCY_LABEL,
  KIND_EMOJI,
  KIND_LABEL,
  LIST_LIMITS,
  browseHrefFor,
  formatListDate,
  type ListFrequency,
  type ListKind,
} from "@/lib/purchase-lists";
import type { ListToCartMode, ListToCartResult, PurchaseListCheck, PurchaseListItemView } from "@/server/services/purchase-lists";

export interface ListHeader {
  id: string;
  name: string;
  kind: ListKind;
  frequency: ListFrequency;
  remind: boolean;
  lastOrderedAt: string | null;
  nextDueAt: string;
}

const NOTE_HINT: Record<ListKind, string> = {
  SHOPPING: "Note (e.g. brand or size)",
  MEDICINE: "Note (e.g. 1 after breakfast — for Papa)",
};

async function send(url: string, init: RequestInit): Promise<{ ok: boolean; payload: unknown }> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { ok: response.ok, payload };
}

function errorMessage(payload: unknown, fallback: string): string {
  return (payload as { error?: { message?: string } } | null)?.error?.message ?? fallback;
}

/** The estimate shown on the list: today's online price × quantity (the check adds offers and delivery). */
function estimate(item: PurchaseListItemView): number {
  if (!item.purchasable || item.unitPricePaise == null || item.quantity === 0 || item.unitSizeMilli == null) return 0;
  return lineTotalPaise(item.unitPricePaise, item.quantity * item.unitSizeMilli);
}

/**
 * One purchase list (docs/purchase-lists-2026-10): quantities for this time
 * (0 = skip), notes, the list's settings, and "Check list" — today's prices
 * and delivery fees in a confirmation step; confirming sends the list to the
 * cart, where checkout takes the address and payment.
 */
export function ListEditor({ list: initialList, initialItems }: { list: ListHeader; initialItems: PurchaseListItemView[] }) {
  const router = useRouter();
  const [list, setList] = useState(initialList);
  const [items, setItems] = useState(initialItems);
  const [saving, setSaving] = useState(0);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<PurchaseListCheck | null>(null);
  // The latest change sent per item: an answer to an older one is ignored (it may arrive last).
  const latest = useRef(new Map<string, number>());

  // router.refresh() re-renders the page with the list as the server has it; adopt it once no
  // change is on its way (render-time sync, not an effect).
  const [seen, setSeen] = useState({ list: initialList, items: initialItems });
  if ((seen.list !== initialList || seen.items !== initialItems) && saving === 0) {
    setSeen({ list: initialList, items: initialItems });
    setList(initialList);
    setItems(initialItems);
  }

  const activeItems = items.filter((i) => i.quantity > 0);
  const orderableItems = activeItems.filter((i) => i.purchasable);
  const estimatedPaise = items.reduce((sum, i) => sum + estimate(i), 0);
  const unavailableActive = activeItems.length - orderableItems.length;

  async function saveItem(itemId: string, change: { quantity?: number; note?: string | null }) {
    const sent = (latest.current.get(itemId) ?? 0) + 1;
    latest.current.set(itemId, sent);
    setItems((current) => current.map((i) => (i.itemId === itemId ? { ...i, ...change } : i)));
    setSaving((n) => n + 1);
    setError(null);
    try {
      const { ok, payload } = await send(`/api/purchase-lists/${list.id}/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify(change),
      });
      if (latest.current.get(itemId) !== sent) return;
      if (!ok) {
        setError(errorMessage(payload, "Could not save that change."));
        router.refresh();
        return;
      }
      const saved = payload as PurchaseListItemView;
      setItems((current) => current.map((i) => (i.itemId === itemId ? saved : i)));
    } catch {
      if (latest.current.get(itemId) !== sent) return;
      setError("Could not save that change. Check your connection.");
      router.refresh();
    } finally {
      setSaving((n) => n - 1);
    }
  }

  async function removeItem(itemId: string) {
    if (removing.has(itemId)) return;
    setRemoving((current) => new Set(current).add(itemId));
    setSaving((n) => n + 1);
    setError(null);
    try {
      const response = await fetch(`/api/purchase-lists/${list.id}/items/${itemId}`, { method: "DELETE" });
      // 404: it is already gone (removed in another tab, or by an earlier tap).
      if (!response.ok && response.status !== 404) {
        const payload = await response.json().catch(() => null);
        setError(errorMessage(payload, "Could not remove that product."));
        return;
      }
      setItems((current) => current.filter((i) => i.itemId !== itemId));
    } catch {
      setError("Could not remove that product. Check your connection.");
    } finally {
      setSaving((n) => n - 1);
      setRemoving((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }
  }

  async function runCheck() {
    setChecking(true);
    setError(null);
    try {
      const response = await fetch(`/api/purchase-lists/${list.id}/check`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(errorMessage(payload, "Could not check the list."));
        return;
      }
      setCheck(payload as PurchaseListCheck);
    } catch {
      setError("Could not check the list. Check your connection.");
    } finally {
      setChecking(false);
    }
  }

  async function deleteList() {
    const { ok, payload } = await send(`/api/purchase-lists/${list.id}`, { method: "DELETE" });
    if (!ok) {
      setError(errorMessage(payload, "Could not delete the list."));
      return;
    }
    router.push("/lists");
    router.refresh();
  }

  const lastOrdered = list.lastOrderedAt ? formatListDate(list.lastOrderedAt) : null;
  const dueNow = activeItems.length > 0 && new Date(list.nextDueAt) <= new Date();

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]" data-testid="list-editor">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl" data-testid="list-name">
              <span aria-hidden>{KIND_EMOJI[list.kind]}</span> {list.name}
            </h1>
            <p className="mt-1 text-sm text-ink-500">
              {KIND_LABEL[list.kind]} · {FREQUENCY_LABEL[list.frequency]}
              {lastOrdered ? ` · Last ordered ${lastOrdered}` : ""} ·{" "}
              {dueNow ? <span className="font-semibold text-kesari-700">Due now</span> : `Next due ${formatListDate(list.nextDueAt)}`}
              {list.remind ? "" : " · Reminder off"}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            {editing ? "Close settings" : "Edit list"}
          </Button>
        </div>

        {editing ? (
          <ListSettings
            list={list}
            onSaved={(next) => {
              setList(next);
              setEditing(false);
              router.refresh();
            }}
            onDelete={deleteList}
          />
        ) : null}

        {error ? (
          <Alert tone="danger">
            <span role="alert">{error}</span>
          </Alert>
        ) : null}

        {items.length > 0 ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-cream-200 bg-white p-3 lg:hidden" data-testid="list-check-bar">
            <div className="text-sm">
              <p className="font-semibold text-ink-900">
                <Money paise={estimatedPaise} />
              </p>
              <p className="text-xs text-ink-500">
                {orderableItems.length} of {items.length} to order
              </p>
            </div>
            <Button onClick={() => void runCheck()} disabled={checking || saving > 0 || activeItems.length === 0}>
              {checking ? "Checking…" : saving > 0 ? "Saving…" : "Check list"}
            </Button>
          </div>
        ) : null}

        {items.length === 0 ? (
          <Card className="p-6 text-center" data-testid="list-empty">
            <p className="font-medium text-ink-900">This list is empty</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-600">
              Open a shop and tap <strong>Add to list</strong> on a product, or fill your cart and use <strong>Save as a list</strong> on the cart page.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <LinkButton href={browseHrefFor(list.kind)}>{list.kind === "MEDICINE" ? "Find a pharmacy" : "Browse shops"}</LinkButton>
              <LinkButton href="/cart" variant="secondary">
                Go to my cart
              </LinkButton>
            </div>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="border-b border-cream-200 bg-cream-50 px-4 py-2 text-xs text-ink-600">
              Set how many you need this time. <strong>0</strong> skips a product this time but keeps it on the list.
            </div>
            <ul className="divide-y divide-cream-200">
              {items.map((item) => (
                <ItemRow
                  key={item.itemId}
                  item={item}
                  kind={list.kind}
                  onQuantity={(quantity) => void saveItem(item.itemId, { quantity })}
                  onNote={(note) => void saveItem(item.itemId, { note })}
                  onRemove={() => void removeItem(item.itemId)}
                  removing={removing.has(item.itemId)}
                />
              ))}
            </ul>
          </Card>
        )}

        {items.length > 0 ? (
          <p className="text-sm">
            <Link href={browseHrefFor(list.kind)} className="font-medium text-kesari-700 hover:underline">
              + Add more products
            </Link>
          </p>
        ) : null}
      </div>

      <aside>
        <Card className="space-y-3 p-4 lg:sticky lg:top-24">
          <h2 className="text-base font-semibold text-ink-900">This time</h2>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-ink-600">Products to order</span>
              <span className="font-medium tabular-nums" data-testid="list-active-count">
                {orderableItems.length} of {items.length}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-600">Estimated items total</span>
              <span className="font-semibold" data-testid="list-estimate">
                <Money paise={estimatedPaise} />
              </span>
            </div>
          </div>
          {unavailableActive > 0 ? (
            <p className="text-xs text-amber-800">
              {unavailableActive} product{unavailableActive === 1 ? "" : "s"} can&apos;t be ordered right now and will be left out.
            </p>
          ) : null}
          <p className="text-xs text-ink-500">Check the list for today&apos;s prices, offers and delivery charges before you order.</p>
          <Button
            size="lg"
            className="w-full"
            onClick={() => void runCheck()}
            disabled={checking || saving > 0 || activeItems.length === 0}
            data-testid="check-list"
          >
            {checking ? "Checking…" : saving > 0 ? "Saving…" : "Check list"}
          </Button>
          {activeItems.length === 0 && items.length > 0 ? (
            <p className="text-xs text-ink-500">Set a quantity above 0 for something to order.</p>
          ) : null}
        </Card>
      </aside>

      {check ? (
        <CheckDialog
          check={check}
          onClose={() => setCheck(null)}
          onOrdered={(result) => {
            if (result.notAdded.length === 0) {
              router.push("/cart");
              return;
            }
            // The cart badge and the list's last-ordered / next-due dates, as the server now has them.
            router.refresh();
          }}
          listId={list.id}
        />
      ) : null}
    </div>
  );
}

function ItemRow({
  item,
  kind,
  onQuantity,
  onNote,
  onRemove,
  removing,
}: {
  item: PurchaseListItemView;
  kind: ListKind;
  onQuantity: (quantity: number) => void;
  onNote: (note: string | null) => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const [draft, setDraft] = useState(String(item.quantity));
  const [note, setNote] = useState(item.note ?? "");
  // Adopt the saved value when the server answers (render-time sync, not an effect).
  const [shown, setShown] = useState(item.quantity);
  if (shown !== item.quantity) {
    setShown(item.quantity);
    setDraft(String(item.quantity));
  }

  function commitDraft() {
    const value = Number.parseInt(draft, 10);
    if (!Number.isFinite(value)) {
      setDraft(String(item.quantity));
      return;
    }
    const clamped = Math.max(0, Math.min(LIST_LIMITS.maxQuantity, value));
    setDraft(String(clamped));
    if (clamped !== item.quantity) onQuantity(clamped);
  }

  const skipped = item.quantity === 0;
  return (
    <li className={`flex gap-3 p-4 ${skipped ? "bg-cream-50" : ""}`} data-testid="list-item" data-product-name={item.productName}>
      <SafeImage src={item.imageUrl} alt={item.productName} className="h-14 w-14 shrink-0 rounded-lg bg-cream-100 object-cover" />
      <div className="min-w-0 flex-1">
        <p className={`font-medium ${item.exists ? "text-ink-900" : "text-ink-500 line-through"}`}>{item.productName}</p>
        <p className="text-xs text-ink-500">
          {item.shop ? (
            <Link href={`/shops/${item.shop.slug}`} className="hover:underline">
              {item.shop.name}
            </Link>
          ) : null}
          {item.unit && item.unitSizeMilli ? ` · ${formatQuantity(item.unitSizeMilli, item.unit)} per unit` : ""}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          {item.unitPricePaise != null && item.exists ? (
            <span className="text-ink-600">
              <Money paise={item.unitPricePaise} /> each
            </span>
          ) : null}
          {skipped ? <Badge tone="neutral">Skipped this time</Badge> : null}
          {!item.purchasable && item.unavailableReason ? <Badge tone="danger">{item.unavailableReason}</Badge> : null}
        </div>
        <input
          className={`${inputClass} mt-2 py-1.5 text-xs`}
          value={note}
          maxLength={LIST_LIMITS.noteLength}
          placeholder={NOTE_HINT[kind]}
          aria-label={`Note for ${item.productName}`}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            const next = note.trim() || null;
            if (next !== (item.note ?? null)) onNote(next);
          }}
        />
      </div>
      <div className="flex flex-col items-end justify-between gap-2">
        <span className="text-sm font-medium text-ink-900">{estimate(item) > 0 ? <Money paise={estimate(item)} /> : <span className="text-ink-500">—</span>}</span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Decrease ${item.productName}`}
            disabled={item.quantity <= 0}
            onClick={() => onQuantity(item.quantity - 1)}
          >
            −
          </Button>
          <input
            className="h-10 w-12 rounded-lg border border-cream-200 text-center text-sm tabular-nums"
            inputMode="numeric"
            aria-label={`Quantity of ${item.productName}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 2))}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Increase ${item.productName}`}
            disabled={item.quantity >= LIST_LIMITS.maxQuantity || !item.exists}
            onClick={() => onQuantity(item.quantity + 1)}
          >
            +
          </Button>
        </div>
        <button
          type="button"
          className="min-h-9 text-xs font-medium text-red-700 hover:underline disabled:text-ink-500"
          onClick={onRemove}
          disabled={removing}
        >
          {removing ? "Removing…" : "Remove"}
        </button>
      </div>
    </li>
  );
}

function ListSettings({
  list,
  onSaved,
  onDelete,
}: {
  list: ListHeader;
  onSaved: (list: ListHeader) => void;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(list.name);
  const [kind, setKind] = useState(list.kind);
  const [frequency, setFrequency] = useState(list.frequency);
  const [remind, setRemind] = useState(list.remind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { ok, payload } = await send(`/api/purchase-lists/${list.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, kind, frequency, remind }),
      });
      if (!ok) {
        setError(errorMessage(payload, "Could not save the list."));
        return;
      }
      const saved = payload as { name: string; kind: ListKind; frequency: ListFrequency; remind: boolean; nextDueAt: string };
      onSaved({ ...list, name: saved.name, kind: saved.kind, frequency: saved.frequency, remind: saved.remind, nextDueAt: saved.nextDueAt });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4" data-testid="list-settings">
      <form onSubmit={save} className="space-y-4">
        <Field label="List name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={LIST_LIMITS.nameLength} required />
        </Field>
        <Choice
          label="What is it for?"
          name="edit-kind"
          value={kind}
          onChange={setKind}
          options={(["SHOPPING", "MEDICINE"] as const).map((k) => ({ value: k, label: `${KIND_EMOJI[k]} ${KIND_LABEL[k]}` }))}
        />
        <Choice
          label="How often?"
          name="edit-frequency"
          value={frequency}
          onChange={setFrequency}
          options={(["WEEKLY", "MONTHLY"] as const).map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))}
        />
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} className="h-4 w-4" />
          Remind me when it is due again
        </label>
        {error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <ConfirmButton confirmLabel="Yes, delete list" question="Delete this list?" onConfirm={() => void onDelete()}>
            Delete list
          </ConfirmButton>
        </div>
      </form>
    </Card>
  );
}

/** The confirmation step: the list priced now, and where it goes (added to the cart, or replacing it). */
function CheckDialog({
  check,
  listId,
  onClose,
  onOrdered,
}: {
  check: PurchaseListCheck;
  listId: string;
  onClose: () => void;
  onOrdered: (result: ListToCartResult) => void;
}) {
  const [mode, setMode] = useState<ListToCartMode>("ADD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ListToCartResult | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { preview } = check;
  const orderable = preview.groups.flatMap((g) => g.lines).filter((l) => l.purchasable);
  const leftOut = preview.groups.flatMap((g) => g.lines).filter((l) => !l.purchasable);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const { ok, payload } = await send(`/api/purchase-lists/${listId}/order`, { method: "POST", body: JSON.stringify({ mode }) });
      if (!ok) {
        setError(errorMessage(payload, "Could not send the list to your cart."));
        return;
      }
      const outcome = payload as ListToCartResult;
      setResult(outcome);
      onOrdered(outcome);
    } catch {
      setError("Could not send the list to your cart. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`Confirm order: ${check.listName}`}>
      <div ref={dialogRef} tabIndex={-1} className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl outline-none sm:max-w-lg sm:rounded-2xl" data-testid="list-check-dialog">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-ink-900">
              {!result ? "Confirm your order" : result.added.length > 0 ? "Sent to your cart" : "Nothing could be added"}
            </h2>
            <p className="text-sm text-ink-500">{check.listName} · today&apos;s prices</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-ink-500 hover:bg-cream-100" aria-label="Close">
            ✕
          </button>
        </div>

        {result ? (
          <div className="mt-4 space-y-3" data-testid="list-order-result">
            {result.added.length > 0 ? (
              <Alert tone="success" title={`${result.added.length} product${result.added.length === 1 ? "" : "s"} added to your cart`}>
                Choose the delivery address, time and payment at checkout.
              </Alert>
            ) : (
              <Alert tone="warning" title="Your cart was not changed">
                None of this list&apos;s products can be ordered right now. Lower a quantity or try again later.
              </Alert>
            )}
            {result.notAdded.length > 0 ? (
              <Alert tone="warning" title="Left out">
                <ul className="list-disc pl-4">
                  {result.notAdded.map((n) => (
                    <li key={n.shopProductId}>
                      {n.productName} — {n.reason}
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {result.added.length > 0 ? (
                <LinkButton href="/cart" className="flex-1">
                  Go to checkout
                </LinkButton>
              ) : null}
              <Button variant="secondary" onClick={onClose}>
                Back to list
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {preview.groups.map((group) => (
              <div key={group.shop.id} className="rounded-xl border border-cream-200" data-testid="check-shop">
                <p className="border-b border-cream-200 bg-cream-50 px-3 py-2 text-sm font-medium text-ink-900">{group.shop.name}</p>
                <ul className="divide-y divide-cream-200 text-sm">
                  {group.lines.map((line) => (
                    <li key={line.cartItemId} className="flex items-start justify-between gap-3 px-3 py-2">
                      <span className={line.purchasable ? "text-ink-800" : "text-ink-500"}>
                        {line.productName} × {line.quantity}
                        {line.offerTitle ? (
                          <span className="ml-1">
                            <Badge tone="success">{line.offerTitle}</Badge>
                          </span>
                        ) : null}
                        {!line.purchasable ? (
                          <span className="mt-0.5 block">
                            <Badge tone="danger">{line.unavailableReason}</Badge>
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 tabular-nums">{line.purchasable ? <Money paise={line.lineTotalPaise} /> : "—"}</span>
                    </li>
                  ))}
                </ul>
                <div className="space-y-0.5 border-t border-cream-200 px-3 py-2 text-xs text-ink-600">
                  <div className="flex justify-between">
                    <span>Subtotal</span>
                    <Money paise={group.subtotalPaise} />
                  </div>
                  <div className="flex justify-between">
                    <span>Delivery</span>
                    {group.deliveryFeePaise > 0 ? <Money paise={group.deliveryFeePaise} /> : <span>Free</span>}
                  </div>
                </div>
              </div>
            ))}

            <div className="rounded-xl bg-kesari-50 px-3 py-3">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold text-ink-900">
                  {check.cartItemCount > 0 && mode === "ADD" ? "Total for this list" : "Total to pay"}
                </span>
                <span className="text-xl font-bold text-ink-900" data-testid="check-total">
                  <Money paise={preview.grandTotalPaise} />
                </span>
              </div>
              {check.cartItemCount > 0 && mode === "ADD" ? (
                <p className="mt-1 text-xs text-ink-600">
                  Plus what is already in your cart. Stock is checked again for the combined quantity, and checkout shows the final total.
                </p>
              ) : null}
            </div>

            {leftOut.length > 0 ? (
              <Alert tone="warning">
                {leftOut.length} product{leftOut.length === 1 ? "" : "s"} can&apos;t be ordered right now and will be left out. You can lower the quantity on the list and check again.
              </Alert>
            ) : null}
            {check.skipped.length > 0 ? (
              <p className="text-xs text-ink-500">Skipped this time: {check.skipped.map((s) => s.productName).join(", ")}</p>
            ) : null}
            {check.missing.length > 0 ? (
              <p className="text-xs text-ink-500">No longer sold (remove from the list): {check.missing.map((m) => m.productName).join(", ")}</p>
            ) : null}

            {check.cartItemCount > 0 ? (
              <Choice
                label={`Your cart already has ${check.cartItemCount} item${check.cartItemCount === 1 ? "" : "s"}`}
                name="list-cart-mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "ADD", label: "Add this list to them" },
                  { value: "REPLACE", label: "Replace my cart with this list" },
                ]}
              />
            ) : null}

            <p className="text-xs text-ink-500">
              Confirming puts these products in your cart. You choose the delivery address, time and payment at checkout — nothing is charged yet.
            </p>
            {error ? (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="lg" className="flex-1" onClick={() => void confirm()} disabled={busy || orderable.length === 0} data-testid="confirm-list-order">
                {busy ? "Adding…" : "Confirm order"}
              </Button>
              <Button size="lg" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
