export function SearchBar() {
  return (
    <div className="border-b border-cream-200 bg-white">
      <div className="mx-auto w-full max-w-6xl px-4 py-3 sm:px-6">
        <form action="/search" className="flex gap-2">
          <input
            type="search"
            name="q"
            placeholder="Search for a product, e.g. milk, paracetamol, screws"
            aria-label="Search products, shops, area or PIN code"
            className="min-w-0 flex-1 rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-sm placeholder:text-ink-400 focus:border-kesari-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-700"
          >
            Search
          </button>
        </form>
      </div>
    </div>
  );
}
