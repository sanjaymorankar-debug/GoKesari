/** Task 5: every HTML email opens with the GoKesari wordmark (all saffron, G and K bold) and the saffron tagline. */
import { describe, expect, it } from "vitest";

import { EMAIL_BRAND_SAFFRON, emailBrandHeader, withEmailBrand } from "@/server/email/brand";
import { magicLinkEmail } from "@/server/auth-email";

describe("email wordmark", () => {
  it("colours Go and Kesari saffron, bolds G and K, and adds the saffron bold tagline", () => {
    const html = emailBrandHeader();
    expect(html).toContain(`<span style="color:${EMAIL_BRAND_SAFFRON}"><span style="font-weight:800">G</span>o</span>`);
    expect(html).toContain(`<span style="color:${EMAIL_BRAND_SAFFRON}"><span style="font-weight:800">K</span>esari</span>`);
    expect(html).toMatch(new RegExp(`font-weight:700;color:${EMAIL_BRAND_SAFFRON}">Everything for Everyone`));
  });

  it("is added once, however often a body passes through", () => {
    const once = withEmailBrand("<p>Hi</p>");
    expect(withEmailBrand(once)).toBe(once);
    expect(once.endsWith("<p>Hi</p>")).toBe(true);
  });

  it("is on the sign-in link email", () => {
    expect(magicLinkEmail("https://gokesari.com/api/auth/callback?token=a").html).toContain("Everything for Everyone");
  });
});
