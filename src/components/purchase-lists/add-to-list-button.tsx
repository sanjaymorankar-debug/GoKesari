"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

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
 * on it. The lists are fetched only when the picker opens, so a page of
 * product cards costs nothing extra. The picker opens in place (not as a
 * pop-over), so a card in a scrolling row cannot clip it.
 */
export function AddToListButton({ shopProductId, productName }: { shopProductId: string; productName: string }) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<ListOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string; listId?: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<ListKind>("SHOPPING");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function openPicker() {
    setOpen((v) => !v);
    setMessage(null);
    if (lists !== null) return;
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
    <div ref={ref}>
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
      {open ? (
        <div
          className="mt-1 rounded-xl border border-cream-200 bg-white p-2 shadow-sm"
          role="dialog"
          aria-label="Choose a list"
          data-testid="add-to-list-picker"
        >
          <p className="px-1 pb-1 text-xs font-medium text-ink-500">Add to which list?</p>
          {lists === null ? (
            <p className="px-1 py-2 text-xs text-ink-500">Loading…</p>
          ) : (
            <ul className="max-h-48 overflow-y-auto">
              {lists.map((list) => (
                <li key={list.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void addTo(list)}
                    className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-ink-800 hover:bg-cream-100"
                  >
                    <span aria-hidden>{KIND_EMOJI[list.kind]}</span>
                    <span className="truncate">{list.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={createAndAdd} className="mt-1 space-y-1.5 border-t border-cream-200 pt-2">
            <input
              className={`${inputClass} py-1.5 text-xs`}
              placeholder="New list name"
              aria-label="New list name"
              value={newName}
              maxLength={LIST_LIMITS.nameLength}
              onChange={(e) => setNewName(e.target.value)}
            />
            <div className="flex gap-1">
              <select
                className={`${inputClass} py-1.5 text-xs`}
                aria-label="New list type"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as ListKind)}
              >
                <option value="SHOPPING">Shopping</option>
                <option value="MEDICINE">Medicines</option>
              </select>
              <Button type="submit" size="sm" disabled={busy || !newName.trim()}>
                Create
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
