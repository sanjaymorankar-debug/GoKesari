"use client";

import Link from "next/link";
import { useLayoutEffect, useRef } from "react";

export type FooterLink = { href: string; label: string };

/**
 * One tight, centred row of footer links separated by "·". When the row wraps
 * (always on a phone), the separator in front of the first link of each line
 * is hidden, so no line starts with a stray dot. Each link keeps a 24px tap
 * height (WCAG 2.2 target size).
 */
export function FooterLinkRow({ label, links }: { label: string; links: FooterLink[] }) {
  const list = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    const ul = list.current;
    if (!ul) return;
    const mark = () => {
      let top: number | null = null;
      for (const li of Array.from(ul.children) as HTMLElement[]) {
        const lineStart = top === null || li.offsetTop > top + 2;
        li.dataset.lineStart = lineStart ? "true" : "false";
        top = li.offsetTop;
      }
    };
    mark();
    const observer = new ResizeObserver(mark);
    observer.observe(ul);
    return () => observer.disconnect();
  }, []);

  return (
    <nav aria-label={label}>
      <ul ref={list} className="flex flex-wrap items-center justify-center gap-y-0.5">
        {links.map((link, i) => (
          <li key={link.href} data-line-start={i === 0 ? "true" : "false"} className="group inline-flex items-center">
            <span aria-hidden="true" className="select-none px-1.5 text-ink-400 group-data-[line-start=true]:hidden">
              ·
            </span>
            <Link href={link.href} className="inline-flex min-h-6 items-center hover:text-ink-900 hover:underline">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
