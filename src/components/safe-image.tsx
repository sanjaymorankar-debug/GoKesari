"use client";

import { useState } from "react";

import { sizedImageUrl, type ImageSize } from "@/lib/image-size";

/** Shown when a product has no photo or its photo fails to load. */
const PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#f5f0e8"/>' +
      '<path d="M30 84l20-24 14 16 10-12 16 20z" fill="#d6cfc2"/><circle cx="46" cy="42" r="8" fill="#d6cfc2"/></svg>',
  );

/**
 * An <img> that never shows a broken-image icon: a missing source or a failed
 * load falls back to a neutral placeholder. Lazy-loaded, sized by the caller.
 */
export function SafeImage({
  src,
  alt,
  className,
  size,
  fallbackEmoji,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  /** Module 1: ask for a processed photo's smaller copy (ignored for other images). */
  size?: ImageSize;
  /** No photo: a category picture on a tinted tile instead of the grey placeholder. */
  fallbackEmoji?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = sizedImageUrl(src, size);
  if ((!url || failed) && fallbackEmoji) {
    return (
      <span role="img" aria-label={alt} className={`grid place-items-center bg-kesari-50 text-5xl ${className ?? ""}`} data-testid="image-fallback">
        <span aria-hidden>{fallbackEmoji}</span>
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={!url || failed ? PLACEHOLDER : url}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
