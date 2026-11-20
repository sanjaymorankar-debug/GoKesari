"use client";

import { useEffect } from "react";

/**
 * Runs an async loader when the component mounts and whenever the loader changes (its
 * useCallback dependencies). It starts on a microtask, so the loader's setState calls happen
 * after the fetch and never synchronously inside the effect; no timer, so a background tab's
 * timer throttling cannot delay it.
 */
export function useLoad(load: () => Promise<void>): void {
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => (cancelled ? undefined : load()));
    return () => {
      cancelled = true;
    };
  }, [load]);
}
