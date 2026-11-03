/**
 * Route-handler plumbing.
 *
 * Every API route is thin by design: parse → authorize → call a service →
 * respond. Business logic never lives in a route file.
 *
 * `route()` centralises error mapping so a thrown AppError becomes the right
 * status code and a safe message, and anything unexpected becomes a generic 500
 * with the detail logged server-side only (§53).
 */
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

import { toClientError, validationFailed } from "@/lib/errors";

export type RouteContext<P = Record<string, string>> = {
  params: Promise<P>;
};

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/**
 * An error answer. QA D-118: Hostinger's CDN kept a 404 with no Cache-Control
 * for 10–20 s and served it to the next caller (the invoice's own customer got
 * another user's "not found"), so an error is never stored by any cache.
 */
export function errorResponse(error: unknown): NextResponse {
  const { status, body } = toClientError(error);
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

/**
 * Wraps a handler with uniform error handling.
 *
 * ZodError is converted to a field-level 422 so forms can highlight the exact
 * inputs that failed.
 */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ZodError) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of error.issues) {
          fieldErrors[issue.path.join(".") || "_"] = issue.message;
        }
        return errorResponse(
          validationFailed("Please check the highlighted fields.", {
            fields: fieldErrors,
          }),
        );
      }
      return errorResponse(error);
    }
  };
}

/** Parses and validates a JSON body. Rejects malformed JSON with a clear 422. */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw validationFailed("Request body must be valid JSON.");
  }
  return schema.parse(raw);
}

/** Parses query-string parameters against a schema. */
export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  return schema.parse(raw);
}
