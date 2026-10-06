/**
 * Read-only rating display. Kept apart from rating-actions.tsx (a client
 * module of rating forms) so pages that only show a rating don't ship those
 * forms to the browser.
 */

/** Read-only star display, e.g. "4.3 ★ (12)". */
export function RatingBadge({ avgX100, count }: { avgX100: number; count: number }) {
  if (count === 0) return <span className="text-xs text-ink-400">No ratings yet</span>;
  return (
    <span className="text-xs font-medium text-ink-700" aria-label={`Rated ${(avgX100 / 100).toFixed(1)} out of 5 from ${count} ratings`}>
      {(avgX100 / 100).toFixed(1)} <span className="text-kesari-500">★</span> ({count})
    </span>
  );
}
