/**
 * Module 1: processed product photos have thumbnail, medium and large WebP
 * copies, served by GET /api/images/{id}?size=. Any other URL (an external
 * photo, a data URI) is returned unchanged; an image without copies is served
 * at its only size by the same route.
 */
export type ImageSize = "thumb" | "medium" | "large";

const STORED = /^\/api\/images\/[0-9a-f-]{36}$/i;

export function sizedImageUrl(url: string | null | undefined, size: ImageSize | undefined): string | null | undefined {
  if (!url || !size || !STORED.test(url)) return url;
  return `${url}?size=${size}`;
}
