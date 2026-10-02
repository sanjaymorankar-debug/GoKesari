"use client";

/**
 * Unsaved-changes guard for the explicit-save admin screens.
 *
 * App Router has no router events (`router.events` was removed), so a dirty
 * form cannot globally intercept navigation. Two mechanisms cover it instead:
 *
 *  - `beforeunload` — a reload, a tab close, or leaving for another origin.
 *    The browser shows its own wording; a page cannot choose the text.
 *  - `onNavigate` on `next/link` — a client-side navigation inside the app.
 *    This is the documented Next 16 pattern (see the "Blocking navigation"
 *    example in the `Link` API reference); `GuardedLink` wraps it.
 *
 * The guard is page-scoped by design: only links rendered inside a provider
 * are guarded. The site header lives outside it, so a click there leaves
 * without a prompt — covering that would mean putting a provider in the root
 * layout and swapping every header link.
 */

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export const LEAVE_MESSAGE = "You have unsaved changes. Leave without saving?";

interface UnsavedChangesValue {
  /** True while at least one form inside this provider holds unsaved edits. */
  isDirty: boolean;
  /** Called by `useSaveChanges`; keyed so several forms can share one provider. */
  setDirty: (key: string, dirty: boolean) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesValue>({
  isDirty: false,
  setDirty: () => {},
});

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(() => new Set());

  const setDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((current) => {
      if (current.has(key) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const isDirty = dirtyKeys.size > 0;

  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Both are needed: `preventDefault()` is the standard, `returnValue` is
      // what older browsers read.
      event.preventDefault();
      event.returnValue = LEAVE_MESSAGE;
      return LEAVE_MESSAGE;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  const value = useMemo(() => ({ isDirty, setDirty }), [isDirty, setDirty]);
  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
}

export function useUnsavedChanges(): UnsavedChangesValue {
  return useContext(UnsavedChangesContext);
}

/**
 * A `next/link` that asks before abandoning unsaved edits. Outside a provider
 * `isDirty` is always false, so it behaves exactly like `Link`.
 */
export function GuardedLink({
  children,
  onNavigate,
  ...props
}: React.ComponentProps<typeof Link>) {
  const { isDirty } = useUnsavedChanges();
  return (
    <Link
      {...props}
      onNavigate={(event) => {
        if (isDirty && !window.confirm(LEAVE_MESSAGE)) {
          event.preventDefault();
          return;
        }
        onNavigate?.(event);
      }}
    >
      {children}
    </Link>
  );
}
