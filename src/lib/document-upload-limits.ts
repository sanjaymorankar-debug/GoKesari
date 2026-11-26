/**
 * Size limits of a document upload (POST /api/shops/<id>/documents/read), shared by the upload panel and the route.
 *
 * Every request passes through src/proxy.ts, and Next.js buffers a proxied request body only up to
 * experimental.proxyClientMaxBodySize (default 10 MB). A larger upload reaches the route cut short, so its form
 * cannot be read: without a check of its own the owner was told "Attach the document" for a file he had just
 * attached (D-165, 25-Nov-2026). The rule documentUpload.maxUploadBytes is capped at the same 10 MB
 * (src/server/config/rules.ts), so this is never below the rule.
 */
export const UPLOAD_REQUEST_LIMIT_BYTES = 10_000_000;

/** The answer for a file over the upload limit (the same words the server uses for documentUpload.maxUploadBytes). */
export function fileTooLargeMessage(maxBytes: number): string {
  return `The file can be at most ${maxBytes / 1_000_000} MB. Take the photo again at a lower size or upload a smaller PDF.`;
}
