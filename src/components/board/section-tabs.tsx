"use client";

import clsx from "clsx";
import { Children, useSyncExternalStore } from "react";

/**
 * One section at a time behind 44 px tabs, for pages that used to stack many
 * sections (several screens on a phone). Every section is rendered on the
 * server and stays in the page; switching is instant. The open tab is kept in
 * the address (#tab-n) so a reload or a shared link opens the same one.
 */
export function SectionTabs({ labels, label, children }: { labels: string[]; label: string; children: React.ReactNode }) {
  const panels = Children.toArray(children);
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash, () => "");
  const fromHash = Number(/^#tab-(\d+)$/.exec(hash)?.[1]);
  const active = Number.isInteger(fromHash) && fromHash >= 0 && fromHash < panels.length ? fromHash : 0;

  function choose(n: number) {
    window.history.replaceState(null, "", `#tab-${n}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  return (
    <div data-testid="section-tabs">
      <div role="tablist" aria-label={label} className="mb-4 flex flex-wrap gap-2">
        {labels.map((text, n) => (
          <button
            key={text}
            type="button"
            role="tab"
            id={`section-tab-${n}`}
            aria-selected={n === active}
            aria-controls={`section-panel-${n}`}
            onClick={() => choose(n)}
            className={clsx(
              "flex h-11 items-center rounded-xl px-4 text-sm font-bold",
              n === active ? "bg-kesari-700 text-white" : "border border-[var(--gk-line)] bg-white text-ink-900 hover:bg-kesari-50",
            )}
          >
            {text}
          </button>
        ))}
      </div>
      {panels.map((panel, n) => (
        <div key={n} role="tabpanel" id={`section-panel-${n}`} aria-labelledby={`section-tab-${n}`} hidden={n !== active}>
          {panel}
        </div>
      ))}
    </div>
  );
}

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
