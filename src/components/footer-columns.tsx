"use client";

/**
 * The footer's labelled link columns (docs/homepage-uiux-2026-10, F5). Wide
 * screens: four columns, always open. Phones: each column is an accordion —
 * the heading is a button (44 px) that shows or hides its links.
 */
import Link from "next/link";
import { useState } from "react";
import clsx from "clsx";

import { Icon } from "@/components/board/icons";

export interface FooterColumn {
  key: string;
  title: string;
  links: { href: string; label: string }[];
}

export function FooterColumns({ columns }: { columns: FooterColumn[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="grid divide-y divide-cream-200 lg:grid-cols-4 lg:gap-8 lg:divide-y-0" data-testid="footer-columns">
      {columns.map((column) => {
        const expanded = open.has(column.key);
        return (
          <nav key={column.key} aria-labelledby={`footer-${column.key}`} data-testid="footer-column" data-key={column.key}>
            <h2 id={`footer-${column.key}`} className="text-sm font-extrabold uppercase tracking-wide text-ink-900">
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={`footer-${column.key}-links`}
                onClick={() => toggle(column.key)}
                className="flex min-h-12 w-full items-center justify-between text-left lg:pointer-events-none lg:min-h-0 lg:pb-2"
              >
                {column.title}
                <Icon name="chevron-down" size={16} className={clsx("text-ink-600 transition-transform lg:hidden", expanded && "rotate-180")} />
              </button>
            </h2>
            <ul id={`footer-${column.key}-links`} className={clsx("pb-2 lg:block lg:pb-0", expanded ? "block" : "hidden")}>
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="flex min-h-11 items-center text-sm text-ink-700 hover:text-ink-900 hover:underline lg:min-h-8">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        );
      })}
    </div>
  );
}
