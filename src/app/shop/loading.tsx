/**
 * Shown at once when a Seller Central page is opened, while the server reads
 * its data (several database round trips on a slow connection). The seller
 * frame (layout) stays in place around it.
 */
export default function SellerPageLoading() {
  return (
    <div className="mx-auto max-w-2xl animate-pulse" role="status" aria-live="polite" aria-label="Loading">
      <div className="mb-2 h-8 w-48 rounded bg-cream-200" />
      <div className="mb-6 h-4 w-72 max-w-full rounded bg-cream-100" />
      <div className="space-y-4 rounded-2xl border border-cream-200 bg-white p-6">
        <div className="h-4 w-32 rounded bg-cream-200" />
        <div className="h-11 rounded-lg bg-cream-100" />
        <div className="h-4 w-40 rounded bg-cream-200" />
        <div className="h-11 rounded-lg bg-cream-100" />
        <div className="h-4 w-28 rounded bg-cream-200" />
        <div className="h-11 rounded-lg bg-cream-100" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
