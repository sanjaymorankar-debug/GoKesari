/**
 * Route-level test helper: calls a Next.js route handler the way the HTTP
 * layer would, so a test proves the actual `route()`-wrapped handler (auth,
 * validation, status codes, error mapping) behaves correctly — not just the
 * service function underneath it. See tests/integration/*-route.test.ts.
 */
import { NextRequest } from "next/server";

export interface CallResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/**
 * Invokes a route handler with a real NextRequest. `path` is appended to
 * `http://localhost` (query strings are supported directly in `path`).
 *
 * `handler` is typed loosely (`(...a: never[]) => Promise<Response>`) rather
 * than against each route's own `RouteContext<{...}>` generic — matching
 * tests/integration/pmd-api.test.ts's existing helper — because every real
 * route handler's params shape differs and none of them needs to be checked
 * here; the cast below is what actually invokes it.
 */
export async function call(
  handler: (...a: never[]) => Promise<Response>,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
  } = {},
): Promise<CallResult> {
  const request = new NextRequest(`http://localhost${path}`, {
    method: init.method ?? "GET",
    ...(init.body !== undefined
      ? {
          body: JSON.stringify(init.body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  });
  const response = await (
    handler as (
      r: NextRequest,
      c: { params: Promise<Record<string, string>> },
    ) => Promise<Response>
  )(request, { params: Promise.resolve(init.params ?? {}) });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}
