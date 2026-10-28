/**
 * Follow-up work after a saved change (audit, notices, follow-on checks).
 * Routes pass Next's `after`, so the answer does not wait for it; services
 * take it as an optional `defer`.
 */

export type Defer = (task: () => Promise<void>) => void;

/**
 * Hands `task` to `defer`, or runs it now when there is none — or when `defer`
 * refuses it (`after` throws outside a request, e.g. a route called from a
 * test or a script). The change is already saved by then, so a refusal must
 * not turn into a failed answer.
 */
export async function runOrDefer(task: () => Promise<void>, defer?: Defer): Promise<void> {
  if (defer) {
    try {
      defer(task);
      return;
    } catch {
      // Not in a request: run it here instead.
    }
  }
  await task();
}
