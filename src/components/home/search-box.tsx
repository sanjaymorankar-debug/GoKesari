"use client";

/**
 * The header search (docs/homepage-uiux-2026-10, F2): a plain GET form to
 * /search (works without JavaScript), plus:
 *  - suggestions while typing (≥ 2 characters, 250 ms debounce) from
 *    /api/search/suggest, grouped Products · Shops · Categories, the typed text
 *    highlighted;
 *  - on focus with nothing typed: recent searches (the account's, or this
 *    browser's for guests) and trending searches;
 *  - keyboard: ↑ ↓ move, Enter opens the highlighted entry (or searches), Esc
 *    closes — the WAI-ARIA combobox pattern;
 *  - voice search through the Web Speech API in the page's language, where the
 *    browser has it (the mic is hidden otherwise).
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";

import { Icon, type IconName } from "@/components/board/icons";
import { LANG_TAG, tr, type Lang } from "@/lib/board/i18n";
import { HOME } from "@/lib/home-i18n";
import { appAllowsVoiceSearch } from "@/lib/mobile-app";

const RECENT_KEY = "gk_recent_searches";
const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

interface Suggestions {
  products: { productId: string; name: string; shopCount: number; nearbyCount: number; href: string }[];
  shops: { slug: string; name: string; area: string | null; city: string; distanceKm: number | null; href: string }[];
  categories: { key: string; label: string; href: string }[];
}

interface Option {
  id: string;
  group: "search" | "recent" | "trending" | "products" | "shops" | "categories";
  label: string;
  detail?: string;
  href: string;
  icon: IconName;
  /** The text a search for this option sends (recorded as a recent search). */
  query?: string;
}

/** Guests' recent searches, newest first (this browser only). */
function readLocalRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

function rememberLocal(query: string) {
  const q = query.trim().toLowerCase().slice(0, 80);
  if (q.length < MIN_CHARS) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...readLocalRecent().filter((v) => v !== q)].slice(0, 6)));
  } catch {
    // Private mode / storage off: recent searches just aren't kept.
  }
}

/** The typed text highlighted wherever it appears in a suggestion. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (q.length < MIN_CHARS) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="rounded-sm bg-kesari-100 font-bold text-ink-900">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
};

const noSubscribe = () => () => {};

function speechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function SearchBox({
  lang,
  signedIn,
  initialQuery = "",
  autoFocus = false,
  size = "md",
  className,
}: {
  lang: Lang;
  signedIn: boolean;
  initialQuery?: string;
  autoFocus?: boolean;
  /** "lg": the home page's tall field; "md": the site header's. */
  size?: "md" | "lg";
  className?: string;
}) {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [trending, setTrending] = useState<{ q: string; label: string }[]>([]);
  const [focusLoaded, setFocusLoaded] = useState(false);
  // The mic only where the browser can listen (false on the server, so both render alike first).
  const voiceSupported = useSyncExternalStore(
    noSubscribe,
    () => Boolean(speechRecognition()) && appAllowsVoiceSearch(navigator.userAgent),
    () => false,
  );
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Suggestions as the visitor types.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/suggest?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (res.ok) setSuggestions(await res.json());
      } catch {
        // Aborted or offline: keep what is shown; Enter still searches.
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // Close on a tap or click outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  const loadFocusLists = useCallback(async () => {
    if (!signedIn) setRecent(readLocalRecent());
    if (focusLoaded) return;
    setFocusLoaded(true);
    try {
      const res = await fetch("/api/search/recent");
      if (!res.ok) return;
      const data = (await res.json()) as { recent: string[]; trending: { q: string; label: string }[] };
      if (signedIn) setRecent(data.recent);
      setTrending(data.trending);
    } catch {
      // Offline: the lists stay empty.
    }
  }, [focusLoaded, signedIn]);

  const typed = query.trim();
  const shopsText = useCallback((n: number) => `${n} ${tr(n === 1 ? HOME.atShop : HOME.atShops, lang)}`, [lang]);
  const options = useMemo<Option[]>(() => {
    if (typed.length === 0) {
      return [
        ...recent.map((q, i) => ({ id: `recent-${i}`, group: "recent" as const, label: q, href: `/search?q=${encodeURIComponent(q)}`, icon: "history" as const, query: q })),
        ...trending.map((t, i) => ({ id: `trend-${i}`, group: "trending" as const, label: t.label, href: `/search?q=${encodeURIComponent(t.q)}`, icon: "trending-up" as const, query: t.q })),
      ];
    }
    const out: Option[] = [{ id: "search", group: "search", label: typed, href: `/search?q=${encodeURIComponent(typed)}`, icon: "search", query: typed }];
    if (suggestions && typed.length >= MIN_CHARS) {
      for (const p of suggestions.products)
        out.push({
          id: `p-${p.productId}`,
          group: "products",
          label: p.name,
          detail: p.nearbyCount > 0 ? `${shopsText(p.nearbyCount)} ${tr(HOME.nearYou, lang)}` : shopsText(p.shopCount),
          href: p.href,
          icon: "package",
          query: p.name,
        });
      for (const s of suggestions.shops)
        out.push({
          id: `s-${s.slug}`,
          group: "shops",
          label: s.name,
          detail: [s.area, s.city].filter(Boolean).join(", ") + (s.distanceKm != null ? ` · ${s.distanceKm} km` : ""),
          href: s.href,
          icon: "store",
        });
      for (const c of suggestions.categories) out.push({ id: `c-${c.key}`, group: "categories", label: c.label, href: c.href, icon: "layout-grid" });
    }
    return out;
  }, [typed, recent, trending, suggestions, shopsText, lang]);

  function go(option: Option | null) {
    const target = option ?? (typed ? { href: `/search?q=${encodeURIComponent(typed)}`, query: typed } : null);
    if (!target) return;
    if (target.query) rememberLocal(target.query);
    setOpen(false);
    setActive(-1);
    inputRef.current?.blur();
    router.push(target.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        void loadFocusLists();
        return;
      }
      if (options.length === 0) return;
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % options.length : i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(open && active >= 0 ? (options[active] ?? null) : null);
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      } else {
        inputRef.current?.blur();
      }
    }
  }

  async function clearRecent() {
    setRecent([]);
    try {
      localStorage.removeItem(RECENT_KEY);
    } catch {
      // Storage off: nothing was kept.
    }
    if (signedIn) await fetch("/api/search/recent", { method: "DELETE" }).catch(() => null);
    inputRef.current?.focus();
  }

  function startVoice() {
    const Recognition = speechRecognition();
    if (!Recognition) return;
    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognition.lang = LANG_TAG[lang];
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (e) => {
      const said = e.results[0]?.[0]?.transcript?.trim();
      if (said) {
        setQuery(said);
        rememberLocal(said);
        router.push(`/search?q=${encodeURIComponent(said)}`);
      }
    };
    recognition.onerror = () => setVoiceError(true);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setVoiceError(false);
    setListening(true);
    try {
      recognition.start();
    } catch {
      setListening(false);
      setVoiceError(true);
    }
  }

  const showList = open && (options.length > 0 || listening || voiceError);
  const groupLabel: Record<Option["group"], string | null> = {
    search: null,
    recent: tr(HOME.recentSearches, lang),
    trending: tr(HOME.trending, lang),
    products: tr(HOME.products, lang),
    shops: tr(HOME.shops, lang),
    categories: tr(HOME.categories, lang),
  };
  const groups: { group: Option["group"]; items: { option: Option; index: number }[] }[] = [];
  options.forEach((option, index) => {
    const last = groups[groups.length - 1];
    if (last && last.group === option.group) last.items.push({ option, index });
    else groups.push({ group: option.group, items: [{ option, index }] });
  });
  const activeId = active >= 0 && options[active] ? `${listId}-${options[active].id}` : undefined;

  return (
    <div ref={boxRef} className={clsx("relative min-w-0", className)} data-testid="search-box">
      <form
        action="/search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          go(null);
        }}
      >
        <label
          className={clsx(
            "flex items-center gap-2 rounded-xl border-2 border-[#f2c9a5] bg-[#fffaf4] pl-3 pr-1 focus-within:border-kesari-600 focus-within:bg-white",
            size === "lg" ? "h-12" : "h-11",
          )}
        >
          <Icon name="search" size={18} className="shrink-0 text-ink-600" />
          <input
            ref={inputRef}
            type="search"
            name="q"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-label={tr(HOME.searchLabel, lang)}
            placeholder={tr(HOME.searchPlaceholder, lang)}
            autoComplete="off"
            enterKeyHint="search"
            autoFocus={autoFocus}
            value={query}
            data-testid="search-input"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(-1);
              setOpen(true);
            }}
            onFocus={() => {
              setOpen(true);
              void loadFocusLists();
            }}
            onKeyDown={onKeyDown}
            className="h-full min-w-0 flex-1 bg-transparent text-base text-ink-900 placeholder:text-ink-600 focus:outline-none focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label={tr(HOME.clear, lang)}
              onClick={() => {
                setQuery("");
                setSuggestions(null);
                inputRef.current?.focus();
              }}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-600 hover:bg-kesari-50"
            >
              <Icon name="x" size={18} />
            </button>
          ) : null}
          {voiceSupported ? (
            <button
              type="button"
              aria-label={tr(HOME.voiceSearch, lang)}
              aria-pressed={listening}
              data-testid="voice-search"
              onClick={() => {
                setOpen(true);
                startVoice();
              }}
              className={clsx(
                "grid h-10 w-10 shrink-0 place-items-center rounded-lg",
                listening ? "animate-pulse bg-kesari-700 text-white" : "text-kesari-700 hover:bg-kesari-50",
              )}
            >
              <Icon name="mic" size={20} />
            </button>
          ) : null}
          <button type="submit" className="sr-only">
            {tr(HOME.submitSearch, lang)}
          </button>
        </label>
      </form>

      {showList ? (
        <div className="absolute inset-x-0 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-cream-200 bg-white py-1.5 shadow-xl" data-testid="search-suggestions">
          {listening ? <p className="px-3 py-2 text-sm font-semibold text-kesari-800">{tr(HOME.listening, lang)}</p> : null}
          {voiceError && !listening ? <p className="px-3 py-2 text-sm text-ink-700">{tr(HOME.voiceFailed, lang)}</p> : null}
          {typed.length === 0 && recent.length > 0 ? (
            <div className="flex justify-end px-3">
              <button type="button" onClick={clearRecent} className="min-h-9 text-xs font-semibold text-kesari-700 hover:underline">
                {tr(HOME.clear, lang)}
              </button>
            </div>
          ) : null}
          <div id={listId} role="listbox" aria-label={tr(HOME.suggestionsLabel, lang)}>
            {groups.map(({ group, items }) => (
              <div key={group} role="group" aria-label={groupLabel[group] ?? tr(HOME.searchFor, lang)}>
                {groupLabel[group] ? (
                  <p aria-hidden className="px-3 pb-1 pt-2 text-xs font-bold uppercase tracking-wide text-ink-600">
                    {groupLabel[group]}
                  </p>
                ) : null}
                {items.map(({ option, index }) => (
                  <a
                    key={option.id}
                    id={`${listId}-${option.id}`}
                    role="option"
                    aria-selected={index === active}
                    href={option.href}
                    data-testid="search-option"
                    data-group={option.group}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.preventDefault();
                      go(option);
                    }}
                    onMouseEnter={() => setActive(index)}
                    className={clsx("flex min-h-11 items-center gap-2.5 px-3 py-1.5 text-sm text-ink-900", index === active ? "bg-kesari-50" : "hover:bg-cream-100")}
                  >
                    <Icon name={option.icon} size={16} className="shrink-0 text-ink-600" />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate">
                        {option.group === "search" ? (
                          <>
                            {tr(HOME.searchFor, lang)} “<strong>{option.label}</strong>”
                          </>
                        ) : (
                          <Highlight text={option.label} query={typed} />
                        )}
                      </span>
                      {option.detail ? <span className="block truncate text-xs text-ink-600">{option.detail}</span> : null}
                    </span>
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
