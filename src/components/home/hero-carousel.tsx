"use client";

/**
 * Home hero banners (docs/homepage-uiux-2026-10, F1): daily deals, seasonal
 * offers, new shops — from Admin → Home banners, or the built-in banners when
 * none is live.
 *
 * The box has a fixed height at every width (no layout shift while images
 * load); only the first banner's image loads eagerly. It turns every few
 * seconds, pauses on hover, touch or keyboard focus and with the pause
 * button, never moves for people who ask for reduced motion, and follows a
 * swipe on touch screens and ← → on the keyboard. Banners not on screen are
 * inert, so their links aren't tabbed to.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";

import { Icon } from "@/components/board/icons";
import { tr, type Lang } from "@/lib/board/i18n";
import { BANNER_ART, bannerSubject, type BannerSlide } from "@/lib/home-banners";
import { HOME } from "@/lib/home-i18n";

const TONES: Record<BannerSlide["kind"], string> = {
  DEAL: "from-kesari-800 to-kesari-600",
  SEASONAL: "from-green-800 to-green-700",
  NEW_SHOPS: "from-indigo-800 to-indigo-600",
  GENERAL: "from-rose-800 to-kesari-700",
};

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const prefersReducedMotion = () => window.matchMedia(REDUCED_MOTION).matches;
function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function HeroCarousel({ lang, slides, intervalSeconds = 6 }: { lang: Lang; slides: BannerSlide[]; intervalSeconds?: number }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const count = slides.length;

  const go = useCallback((next: number) => setIndex(((next % count) + count) % count), [count]);

  useEffect(() => {
    if (count < 2 || paused || userPaused || reducedMotion) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % count), Math.max(3, intervalSeconds) * 1000);
    return () => clearInterval(timer);
  }, [count, paused, userPaused, reducedMotion, intervalSeconds]);

  if (count === 0) return null;

  return (
    <section
      aria-roledescription="carousel"
      aria-label={tr(HOME.offers, lang)}
      data-testid="hero-carousel"
      className="relative overflow-hidden rounded-2xl"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(index + 1);
        if (e.key === "ArrowLeft") go(index - 1);
      }}
      onTouchStart={(e) => {
        setPaused(true);
        touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={(e) => {
        const start = touchStart.current;
        touchStart.current = null;
        setPaused(false);
        if (!start) return;
        const dx = e.changedTouches[0].clientX - start.x;
        const dy = e.changedTouches[0].clientY - start.y;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(index + (dx < 0 ? 1 : -1));
      }}
    >
      <div className="flex h-44 transition-transform duration-500 ease-out motion-reduce:transition-none sm:h-52 lg:h-64" style={{ transform: `translateX(-${index * 100}%)` }}>
        {slides.map((slide, i) => (
          <div
            key={slide.id}
            role="group"
            aria-roledescription="slide"
            aria-label={`${tr(HOME.slide, lang)} ${i + 1} ${tr(HOME.of, lang)} ${count}: ${slide.title}`}
            aria-hidden={i !== index}
            inert={i !== index}
            data-testid="hero-slide"
            className={clsx("relative flex h-full w-full shrink-0 items-stretch bg-gradient-to-r text-white", TONES[slide.kind])}
          >
            <div className="relative z-10 flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-5 py-4 sm:px-8 lg:gap-2.5 lg:px-12">
              <p className="line-clamp-2 text-xl font-extrabold leading-tight sm:text-2xl lg:text-4xl">{slide.title}</p>
              {slide.subtitle ? <p className="line-clamp-2 max-w-xl text-sm text-white/95 sm:text-base lg:text-lg">{slide.subtitle}</p> : null}
              {slide.ctaLabel ? (
                <Link
                  href={slide.ctaHref}
                  className="mt-1 inline-flex h-11 w-max items-center gap-1 rounded-xl bg-white px-4 text-sm font-bold text-ink-900 shadow hover:bg-cream-100 lg:h-12 lg:text-base"
                >
                  {slide.ctaLabel}
                  <Icon name="chevron-right" size={18} />
                </Link>
              ) : null}
            </div>
            <div className="relative w-[34%] shrink-0 sm:w-[38%] lg:w-[42%]">
              {slide.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={slide.imageUrl}
                  alt=""
                  width={640}
                  height={360}
                  loading={i === 0 ? "eager" : "lazy"}
                  fetchPriority={i === 0 ? "high" : "auto"}
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : (
<BannerArt slide={slide} />
              )}
            </div>
          </div>
        ))}
      </div>

      {count > 1 ? (
        <div className="absolute bottom-2 right-2 z-20 flex items-center gap-1 rounded-full bg-ink-900/55 px-1 py-0.5 text-white">
          <button type="button" aria-label={tr(HOME.previousSlide, lang)} onClick={() => go(index - 1)} className="hidden h-11 w-11 place-items-center rounded-full hover:bg-white/20 sm:grid">
            <Icon name="chevron-left" size={18} />
          </button>
          {/* Phones swipe; the arrows join from 640 px, where they fit beside the button. */}
          <span className="flex items-center pl-2 sm:pl-0" aria-hidden>
            {slides.map((s, i) => (
              <span key={s.id} className={clsx("mx-0.5 block h-2 rounded-full transition-all", i === index ? "w-5 bg-white" : "w-2 bg-white/60")} />
            ))}
          </span>
          <span className="sr-only" aria-live={paused || userPaused ? "polite" : "off"}>
            {`${tr(HOME.slide, lang)} ${index + 1} ${tr(HOME.of, lang)} ${count}`}
          </span>
          <button type="button" aria-label={tr(HOME.nextSlide, lang)} onClick={() => go(index + 1)} className="hidden h-11 w-11 place-items-center rounded-full hover:bg-white/20 sm:grid">
            <Icon name="chevron-right" size={18} />
          </button>
          {!reducedMotion ? (
            <button
              type="button"
              aria-label={userPaused ? tr(HOME.playSlides, lang) : tr(HOME.pauseSlides, lang)}
              aria-pressed={userPaused}
              data-testid="hero-pause"
              onClick={() => setUserPaused((v) => !v)}
              className="grid h-11 w-11 place-items-center rounded-full hover:bg-white/20"
            >
              <Icon name={userPaused ? "play" : "pause"} size={16} />
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * A banner with no photo: four pictures from the banner's own subject (a
 * dairy banner shows only dairy) set on a soft disc that fills the panel, so
 * the slide has no large empty area at any width. On phones the pictures
 * sit above the slide controls, which share the bottom-right corner.
 */
function BannerArt({ slide }: { slide: BannerSlide }) {
  const subject = bannerSubject(slide);
  const [main, a, b, c] = BANNER_ART[subject];
  const bubble = "absolute grid place-items-center rounded-full bg-white/20 p-1.5 text-2xl shadow-sm ring-1 ring-white/25 sm:p-2 sm:text-3xl lg:p-3 lg:text-5xl";
  return (
    <span aria-hidden data-testid="hero-art" data-subject={subject} className="absolute inset-x-0 bottom-11 top-0 grid place-items-center sm:bottom-0">
      <span className="absolute aspect-square h-[80%] rounded-full bg-white/10 sm:h-[86%] ring-1 ring-white/15" />
      <span className="relative text-6xl drop-shadow-md sm:text-7xl lg:text-9xl">{main}</span>
      <span className={`${bubble} right-[6%] top-[8%]`}>{a}</span>
      <span className={`${bubble} left-[2%] top-[6%] sm:bottom-[10%] sm:left-[4%] sm:top-auto`}>{b}</span>
      <span className={`${bubble} left-[8%] top-[6%] hidden sm:grid`}>{c}</span>
    </span>
  );
}
