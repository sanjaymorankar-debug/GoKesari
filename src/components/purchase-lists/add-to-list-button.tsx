"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button, inputClass } from "@/components/ui";
import { KIND_EMOJI, LIST_LIMITS, type ListKind } from "@/lib/purchase-lists";

interface ListOption {
  id: string;
  name: string;
  kind: ListKind;
}

/**
 * "Add to list" on a product (docs/purchase-lists-2026-10): picks one of the
 * customer's weekly / monthly lists, or starts a new one, and puts the product
 * on it. The lists are fetched each time the picker opens (so a list made from
 * another card is there too), never with the page. The picker is a sheet over
 * the page — full width on a phone — so a narrow card or a scrolling row
 * cannot squeeze or clip it.
 */
export function AddToListButton({ shopProductId, productName }: { shopProductId: string; productName: string }) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<ListOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string; listId?: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<ListKind>("SHOPPING");
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function openPicker() {
    setOpen(true);
    setMessage(null);
    setLists(null);
    try {
      const response = await fetch("/api/purchase-lists");
      const payload = await response.json().catch(() => null);
      setLists(response.ok ? (payload.lists as ListOption[]) : []);
    } catch {
      setLists([]);
    }
  }

  async function addTo(list: ListOption) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/purchase-lists/${list.id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopProductId, quantity: 1 }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage({ tone: "error", text: payload?.error?.message ?? "Could not add it to the list." });
        return;
      }
      setMessage({
        tone: "ok",
        text: payload.alreadyOnList ? `Already on "${list.name}"` : `Added to "${list.name}"`,
        listId: list.id,
      });
      setOpen(false);
    } catch {
      setMessage({ tone: "error", text: "Could not add it to the list." });
    } finally {
      setBusy(false);
    }
  }

  async function createAndAdd(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/purchase-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, kind: newKind }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage({ tone: "error", text: payload?.error?.message ?? "Could not create the list." });
        return;
      }
      const created: ListOption = { id: payload.id, name: payload.name, kind: payload.kind };
      setLists((current) => [...(current ?? []), created]);
      setNewName("");
      await addTo(created);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button
        size="sm"
        variant="ghost"
        className="tap-target w-full [--tap-h:36px]"
        onClick={() => void openPicker()}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Add ${productName} to one of my lists`}
        data-testid="add-to-list"
      >
        <span aria-hidden>📝</span> Add to list
      </Button>
      {message ? (
        <p className={`mt-1 text-xs ${message.tone === "ok" ? "text-leaf-700" : "text-red-600"}`} role="status">
          {message.text}
          {message.listId ? (
            <>
              {" · "}
              <Link href={`/lists/${message.listId}`} className="font-medium underline">
                Open
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {open ? createPortal(
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={sheetRef}
            tabIndex={-1}
            className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl outline-none sm:max-w-sm sm:rounded-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={`Add ${productName} to a list`}
            data-testid="add-to-list-picker"
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-base font-semibold text-ink-900">Add to which list?</p>
                <p className="truncate text-xs text-ink-500" title={productName}>
                  {productName}
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-2 py-1 text-ink-500 hover:bg-cream-100" aria-label="Close">
                ✕
              </button>
            </div>
            {lists === null ? (
              <p className="py-3 text-sm text-ink-500">Loading…</p>
            ) : lists.length === 0 ? (
              <p className="py-2 text-sm text-ink-600">You have no lists yet — name your first one below.</p>
            ) : (
              <ul className="max-h-64 divide-y divide-cream-100 overflow-y-auto">
                {lists.map((list) => (
                  <li key={list.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void addTo(list)}
                      title={list.name}
                      className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-ink-800 hover:bg-cream-100"
                    >
                      <span aria-hidden>{KIND_EMOJI[list.kind]}</span>
                      <span className="break-words">{list.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={createAndAdd} className="mt-3 space-y-2 border-t border-cream-200 pt-3">
              <p className="text-xs font-medium text-ink-600">Or start a new list</p>
              <input
                className={inputClass}
                placeholder="New list name"
                aria-label="New list name"
                value={newName}
                maxLength={LIST_LIMITS.nameLength}
                onChange={(e) => setNewName(e.target.value)}
              />
              <div className="flex gap-2">
                <select
                  className={`${inputClass} flex-1`}
                  aria-label="New list type"
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value as ListKind)}
                >
                  <option value="SHOPPING">🛒 Shopping</option>
                  <option value="MEDICINE">💊 Medicines</option>
                </select>
                <Button type="submit" disabled={busy || !newName.trim()}>
                  Create &amp; add
                </Button>
              </div>
            </form>
          </div>
        </div>,
        // On <body>, so no card, scrolling row or transformed parent can clip or move it.
        document.body,
      ) : null}
    </div>
  );
}
