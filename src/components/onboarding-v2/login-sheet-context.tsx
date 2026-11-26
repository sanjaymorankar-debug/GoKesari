"use client";

/**
 * The login sheet's context and opener (docs/onboarding-v2-2026-11), kept apart from the sheet itself so
 * components that only open it (cart, phone nav) do not import the sheet's server actions.
 */
import { createContext, useContext } from "react";

export interface LoginSheetOptions {
  /** The page to come back to after the e-mail step (default: this page). */
  returnTo?: string;
  /** Called once the sheet is finished (signed in, mobile done). */
  onDone?: () => void;
}

export const OPEN_EVENT = "gk:open-login-sheet";
export const LoginSheetContext = createContext<((options?: LoginSheetOptions) => void) | null>(null);

/** The opener while onboarding_v2 is on; null when it is off (callers keep their old behaviour). */
export function useLoginSheet(): ((options?: LoginSheetOptions) => void) | null {
  return useContext(LoginSheetContext);
}

/** For code outside React: opens the sheet if the provider is mounted (no-op otherwise). */
export function openLoginSheet(returnTo?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { returnTo } }));
}

