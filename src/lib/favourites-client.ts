"use client";

/**
 * The browser side of favourites (docs/search-brand-barcode-favourites-2026-11): one shared set of
 * saved product ids for every heart on the page, read once.
 *
 *  - Signed in: the account's ids from GET /api/favourites. Hearts a guest left in this browser are
 *    first merged into the account (POST { productIds }) and then cleared — the sign-in merge.
 *  - Guest: the ids kept in localStorage (at most 100), never sent anywhere except to show them.
 *
 * A heart is toggled optimistically and put back when the server refuses.
 */
import { useEffect, useSyncExternalStore } from "react";

export const LOCAL_FAVOURITES_KEY = "gk_favourites";
export const MAX_LOCAL_FAVOURITES = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readLocalFavourites(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_FAVOURITES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && UUID.test(v)).slice(0, MAX_LOCAL_FAVOURITES) : [];
  } catch {
    return [];
  }
}

function writeLocalFavourites(ids: readonly string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(LOCAL_FAVOURITES_KEY);
    else localStorage.setItem(LOCAL_FAVOURITES_KEY, JSON.stringify(ids.slice(0, MAX_LOCAL_FAVOURITES)));
  } catch {
    // Private mode / storage off: the heart works until the page is left.
  }
}

/* ------------------------------------------------------------------ store */

let ids = new Set<string>();
let mode: "none" | "guest" | "account" = "none";
let loading: Promise<void> | null = null;
let lastError: string | null = null;
const listeners = new Set<() => void>();
let snapshot: { ids: Set<string>; error: string | null } = { ids, error: lastError };

function emit() {
  snapshot = { ids, error: lastError };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY = { ids: new Set<string>(), error: null as string | null };

async function loadAccount(): Promise<void> {
  const local = readLocalFavourites();
  if (local.length > 0) {
    // The sign-in merge: a guest's hearts move to the account once, then leave the browser.
    const merged = await fetch("/api/favourites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productIds: local }),
    }).catch(() => null);
    if (merged?.ok) {
      writeLocalFavourites([]);
      const data = (await merged.json().catch(() => null)) as { ids?: string[] } | null;
      if (data?.ids) {
        ids = new Set(data.ids);
        emit();
        return;
      }
    }
  }
  const res = await fetch("/api/favourites").catch(() => null);
  if (!res?.ok) return;
  const data = (await res.json().catch(() => null)) as { ids?: string[] } | null;
  ids = new Set(data?.ids ?? []);
  emit();
}

/** Loads the ids once per page for the given sign-in state (again if it changes). */
export function ensureFavouritesLoaded(signedIn: boolean): Promise<void> {
  const want = signedIn ? "account" : "guest";
  if (mode === want && loading) return loading;
  mode = want;
  if (!signedIn) {
    ids = new Set(readLocalFavourites());
    emit();
    loading = Promise.resolve();
    return loading;
  }
  loading = loadAccount().catch(() => undefined);
  return loading;
}

/** Saves or removes one product. Returns false when it could not be changed. */
export function toggleFavourite(productId: string, signedIn: boolean): Promise<boolean> {
  return setFavourite(productId, !ids.has(productId), signedIn);
}

/** Saves (`save` true) or removes one product, whatever the heart showed. */
export async function setFavourite(productId: string, save: boolean, signedIn: boolean): Promise<boolean> {
  const wasSaved = !save;
  const next = new Set(ids);
  if (wasSaved) next.delete(productId);
  else next.add(productId);
  ids = next;
  lastError = null;
  emit();
  if (!signedIn) {
    if (!wasSaved && next.size > MAX_LOCAL_FAVOURITES) {
      ids = new Set([...next].filter((id) => id !== productId));
      lastError = `Up to ${MAX_LOCAL_FAVOURITES} favourites can be kept in this browser — sign in to keep more.`;
      emit();
      return false;
    }
    writeLocalFavourites([...next]);
    return true;
  }
  const res = await fetch(wasSaved ? `/api/favourites?productId=${encodeURIComponent(productId)}` : "/api/favourites", {
    method: wasSaved ? "DELETE" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(wasSaved ? {} : { body: JSON.stringify({ productId }) }),
  }).catch(() => null);
  if (res?.ok) return true;
  const payload = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
  const back = new Set(ids);
  if (wasSaved) back.add(productId);
  else back.delete(productId);
  ids = back;
  lastError = payload?.error?.message ?? "Could not update your favourites. Try again.";
  emit();
  return false;
}

/** Saved ids and the last error, for every heart on the page. */
export function useFavourites(signedIn: boolean): { ids: ReadonlySet<string>; error: string | null } {
  useEffect(() => {
    void ensureFavouritesLoaded(signedIn);
  }, [signedIn]);
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

/** Test hook: forget everything loaded. */
export function resetFavouritesStore(): void {
  ids = new Set();
  mode = "none";
  loading = null;
  lastError = null;
  emit();
}
