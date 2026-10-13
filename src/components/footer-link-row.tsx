"use client";

import Link from "next/link";
import { Fragment, useLayoutEffect, useRef, useState } from "react";

export type FooterLink = { href: string; label: string };

/**
 * One tight, centred row of footer links separated by "·". When the row wraps
 * (always on a phone), the separator in front of the first link of each line
 * is hidden, so no line starts with a stray dot. Each link keeps a 24px tap
 * height (WCAG 2.2 target size).
 *
 * Lines are measured with every separator showing, then pinned with a
 * zero-height full-width break before each line's first link. Without the
 * pin, dropping a line's leading dot can pull that link up onto the line
 * above, where it then needs its dot back — the row never settles.
 */
export function FooterLinkRow({ label, links }: { label: string; links: FooterLink[] }) {
  const list = useRef<HTMLUListElement>(null);
  // Indexes of the links that start a wrapped line; null = measure again.
  const [breaks, setBreaks] = useState<number[] | null>(null);

  useLayoutEffect(() => {
    if (breaks !== null || !list.current) return;
    const starts: number[] = [];
    let top: number | null = null;
    (Array.from(list.current.children) as HTMLElement[]).forEach((li, i) => {
      if (top !== null && li.offsetTop > top + 2) starts.push(i);
      top = li.offsetTop;
    });
    setBreaks(starts);
  }, [breaks]);

  useLayoutEffect(() => {
    const ul = list.current;
    if (!ul) return;
    let width = ul.clientWidth;
    const observer = new ResizeObserver(() => {
      if (ul.clientWidth === width) return;
      width = ul.clientWidth;
      setBreaks(null);
    });
    observer.observe(ul);
    // Link widths change when the web font arrives.
    document.fonts?.ready.then(() => setBreaks(null));
    return () => observer.disconnect();
  }, []);

  return (
    <nav aria-label={label}>
      <ul ref={list} className="flex flex-wrap items-center justify-center">
        {links.map((link, i) => {
          const lineStart = i === 0 || (breaks?.includes(i) ?? false);
          return (
            <Fragment key={link.href}>
              {i > 0 && lineStart && <li aria-hidden="true" data-line-break="" className="h-0 basis-full" />}
              <li data-line-start={lineStart ? "true" : "false"} className="group inline-flex items-center py-px">
                <span aria-hidden="true" className="select-none px-1.5 text-ink-400 group-data-[line-start=true]:hidden">
                  ·
                </span>
                <Link href={link.href} className="inline-flex min-h-6 items-center hover:text-ink-900 hover:underline">
                  {link.label}
                </Link>
              </li>
            </Fragment>
          );
        })}
      </ul>
    </nav>
  );
}
