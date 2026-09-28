import type { Instrumentation } from "next";

/**
 * Logs the root cause of server errors. Drizzle wraps driver failures as
 * "Failed query: …", which hides the real reason (auth, TLS, network), so the
 * cause chain is printed on its own line. Messages and codes only — never the
 * connection string.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request) => {
  const causes: string[] = [];
  let current: unknown = err instanceof Error ? err.cause : undefined;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      causes.push(`${current.name}: ${current.message}${code ? ` (code ${String(code)})` : ""}`);
      current = current.cause;
    } else {
      causes.push(String(current));
      break;
    }
  }
  if (causes.length > 0) {
    console.error(`[request-error] ${request.method} ${request.path} cause: ${causes.join(" <- ")}`);
  }
};
