/**
 * Release #332 check B-2 (03-Nov-2026): the invoice page's "Download PDF" was a
 * Next.js <Link>, so every view prefetched /api/invoices/<id>/pdf and the server
 * built the PDF in the background. A LinkButton to an API route is a plain link.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className, "data-router-link": "" }, children),
}));

import { LinkButton } from "@/components/ui";

const render = (href: string) => renderToStaticMarkup(createElement(LinkButton, { href } as Parameters<typeof LinkButton>[0], "Go"));

describe("LinkButton (release #332 check B-2)", () => {
  it("links to an API route without the router, so nothing is prefetched", () => {
    const html = render("/api/invoices/00000000-0000-0000-0000-000000000001/pdf");
    expect(html).toContain('href="/api/invoices/00000000-0000-0000-0000-000000000001/pdf"');
    expect(html).not.toContain("data-router-link");
  });

  it("keeps the router link for pages", () => {
    expect(render("/orders")).toContain("data-router-link");
  });
});
