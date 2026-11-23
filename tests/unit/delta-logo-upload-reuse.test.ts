/** docs/delta CF-011: the logo card keeps its shop defaults and can be reused (dealer module) with its own text. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ShopLogoUpload } from "@/components/delta/shop-logo-upload";

describe("ShopLogoUpload reuse", () => {
  it("shows the shop text by default", () => {
    const html = renderToStaticMarkup(createElement(ShopLogoUpload, { shopId: "s1", initialLogoUrl: null }));
    expect(html).toContain("Shop logo");
    expect(html).toContain("Customers see it on your shop card.");
  });

  it("takes another module's heading and hint", () => {
    const html = renderToStaticMarkup(
      createElement(ShopLogoUpload, {
        shopId: "d1",
        initialLogoUrl: null,
        endpoint: "/api/dealer/d1/logo",
        heading: "Dealer logo",
        hint: "Shown on your dealer profile.",
      }),
    );
    expect(html).toContain("Dealer logo");
    expect(html).toContain("Shown on your dealer profile.");
    expect(html).not.toContain("Shop logo");
  });
});
