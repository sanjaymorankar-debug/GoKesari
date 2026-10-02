"use client";

/**
 * The shared explicit-save control for admin screens.
 *
 * The rule it enforces: a form holds its edits locally and **nothing reaches
 * the database until the admin presses Save**. That is the opposite of the
 * save-on-change controls these screens used to have, where a stray click on a
 * `<select>` was already a committed write.
 *
 * `useSaveChanges` owns the save lifecycle — dirty state, the in-flight lock,
 * the optional "Are you sure?" step, the auto-dismissing confirmation and the
 * sticky error — and `SaveChangesBar` renders it. A screen supplies only two
 * things: whether its draft differs from what the server last gave it, and an
 * `onSave` that performs the write and returns the sentence to show.
 *
 * On failure the draft is deliberately left alone: the admin's typing stays on
 * screen, the form stays dirty, and the same button retries.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Alert, Button, Card } from "@/components/ui";
import { useUnsavedChanges } from "@/components/unsaved-changes-guard";

/** How long a success message stays on screen before dismissing itself. */
const NOTICE_TIMEOUT_MS = 5000;

export interface ConfirmSpec {
  title: string;
  /** The staged change, spelled out line by line, so "yes" is informed. */
  lines: string[];
  body?: string;
  confirmLabel?: string;
}

export interface UseSaveChangesOptions {
  /** Distinguishes several forms sharing one UnsavedChangesProvider. */
  id: string;
  /** Does the draft differ from the last server state? The screen decides. */
  dirty: boolean;
  /**
   * Performs the write and resolves with the confirmation sentence, e.g.
   * "Category updated: Grocery → Daily Needs". Throwing surfaces the error
   * message to the admin, so throw something readable (`postJson` does).
   */
  onSave: () => Promise<string>;
  /**
   * Returns the confirmation to show before saving, or null to save straight
   * away. Called at click time so it can describe the current draft.
   */
  confirm?: () => ConfirmSpec | null;
}

export interface SaveChangesState {
  dirty: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  pendingConfirm: ConfirmSpec | null;
  /** Click handler for the Save button: confirms if asked to, else saves. */
  requestSave: () => void;
  confirmSave: () => void;
  cancelConfirm: () => void;
  dismissNotice: () => void;
}

export function useSaveChanges({ id, dirty, onSave, confirm }: UseSaveChangesOptions): SaveChangesState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmSpec | null>(null);

  // `busy` is state, so two clicks in the same tick would both read it as
  // false. The ref is the actual lock against a double submit.
  const inFlight = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const { setDirty } = useUnsavedChanges();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  // Keep the page-level leave guard in step, and release it on unmount.
  useEffect(() => {
    setDirty(id, dirty);
    return () => setDirty(id, false);
  }, [id, dirty, setDirty]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => {
      if (mounted.current) setNotice(null);
    }, NOTICE_TIMEOUT_MS);
  }, []);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await onSave();
      if (mounted.current) showNotice(message);
    } catch (cause) {
      // The draft is untouched, so the admin can correct and press Save again.
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "Could not save your changes. Please try again.");
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [onSave, showNotice]);

  const requestSave = useCallback(() => {
    if (inFlight.current || !dirty) return;
    const spec = confirm?.() ?? null;
    if (spec) {
      setPendingConfirm(spec);
      return;
    }
    void run();
  }, [confirm, dirty, run]);

  const confirmSave = useCallback(() => {
    setPendingConfirm(null);
    void run();
  }, [run]);

  return {
    dirty,
    busy,
    error,
    notice,
    pendingConfirm,
    requestSave,
    confirmSave,
    cancelConfirm: () => setPendingConfirm(null),
    dismissNotice: () => setNotice(null),
  };
}

/**
 * The Save button plus its feedback. Disabled until something actually
 * changed, and disabled again the moment a save succeeds (the screen resets
 * its baseline, which clears `dirty`).
 */
export function SaveChangesBar({
  state,
  label = "Save Changes",
  idleHint = "No unsaved changes.",
  dirtyHint = "You have unsaved changes.",
  children,
  testId,
}: {
  state: SaveChangesState;
  label?: string;
  idleHint?: string;
  dirtyHint?: string;
  /** Extra controls, e.g. a Discard button. */
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="space-y-3" data-testid={testId}>
      {state.error ? (
        <Alert tone="danger" title="Not saved">
          {state.error} Your changes are still here — fix the problem and press {label} again.
        </Alert>
      ) : null}
      {state.notice ? (
        <Alert tone="success">
          <span data-testid="save-confirmation">{state.notice}</span>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={state.requestSave}
          disabled={!state.dirty || state.busy}
          aria-busy={state.busy}
          data-testid="save-changes"
        >
          {state.busy ? "Saving…" : label}
        </Button>
        {children}
        <span className="text-xs text-ink-500" aria-live="polite">
          {state.busy ? "Saving…" : state.dirty ? dirtyHint : idleHint}
        </span>
      </div>
      {state.pendingConfirm ? (
        <ConfirmDialog spec={state.pendingConfirm} onConfirm={state.confirmSave} onCancel={state.cancelConfirm} />
      ) : null}
    </div>
  );
}

function ConfirmDialog({
  spec,
  onConfirm,
  onCancel,
}: {
  spec: ConfirmSpec;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-save-title"
      data-testid="confirm-save"
    >
      <Card className="w-full max-w-md space-y-3 p-5">
        <h2 id="confirm-save-title" className="text-lg font-semibold text-ink-900">
          {spec.title}
        </h2>
        <ul className="space-y-1 rounded-lg bg-cream-50 p-3 text-sm text-ink-700">
          {spec.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {spec.body ? <p className="text-sm text-ink-600">{spec.body}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          {/* autoFocus rather than a ref: `Button` spreads native props but does not type one. */}
          <Button autoFocus onClick={onConfirm} data-testid="confirm-save-yes">
            {spec.confirmLabel ?? "Yes, save changes"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/**
 * Sends JSON to an API route and throws a readable Error on failure, matching
 * the error envelope `route()` produces (`{ error: { message, details } }`).
 * Field-level 422s are joined so a validation failure names the problem rather
 * than saying "that did not work".
 */
export async function postJson<T = unknown>(url: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("Could not reach the server. Check your connection.");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
    throw new Error(
      (fields ? Object.values(fields).join(" ") : undefined) ??
        payload?.error?.message ??
        "Could not save your changes. Please try again.",
    );
  }
  return payload as T;
}
