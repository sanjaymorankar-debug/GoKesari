/** docs/policy-reconsent-2026-11: channel, language fallback and exempt pages. */
import { describe, expect, it } from "vitest";

import { LANGUAGES } from "@/lib/board/i18n";
import {
  channelFor,
  POLICY_DOC_LABEL,
  POLICY_DOC_SLUGS,
  POLICY_VERSION_PATTERN,
  RECONSENT_UI,
  reconsentExemptPath,
  summaryIn,
} from "@/lib/policy-reconsent";
import { POLICY_DOCS } from "@/server/db/schema";

describe("policy re-consent helpers", () => {
  it("names the channel from the portal path, and APP inside the app", () => {
    expect(channelFor("/shop/orders", "Mozilla/5.0")).toBe("SHOP_PORTAL");
    expect(channelFor("/shop", "Mozilla/5.0")).toBe("SHOP_PORTAL");
    expect(channelFor("/shops/abc", "Mozilla/5.0")).toBe("WEB");
    expect(channelFor("/delivery-partner/kyc", null)).toBe("RIDER_PORTAL");
    expect(channelFor("/dealer/leads", null)).toBe("DEALER_PORTAL");
    expect(channelFor("/franchise", null)).toBe("DEALER_PORTAL");
    expect(channelFor("/", "Mozilla/5.0")).toBe("WEB");
    expect(channelFor("/shop/orders", "Mozilla/5.0 GoKesariApp/1.4.0 (android)")).toBe("APP");
  });

  it("shows the summary in the visitor's language, English when blank", () => {
    const s = { en: "Changed", hi: "बदला", mr: " " };
    expect(summaryIn(s, "en")).toBe("Changed");
    expect(summaryIn(s, "hi")).toBe("बदला");
    expect(summaryIn(s, "mr")).toBe("Changed");
    expect(summaryIn(null, "hi")).toBe("");
  });

  it("keeps the policies themselves readable", () => {
    expect(reconsentExemptPath("/legal/terms")).toBe(true);
    expect(reconsentExemptPath("/signin")).toBe(true);
    expect(reconsentExemptPath("/legalese")).toBe(false);
    expect(reconsentExemptPath("/shop")).toBe(false);
  });

  it("accepts date versions only", () => {
    for (const v of ["2026-12-01", "2026-12-01b", "2026-12-01.2"]) expect(POLICY_VERSION_PATTERN.test(v)).toBe(true);
    for (const v of ["v2", "2026-12", "2026-12-01 ", "December"]) expect(POLICY_VERSION_PATTERN.test(v)).toBe(false);
  });

  it("has every label in English, Hindi and Marathi, for every document the database knows", () => {
    expect([...POLICY_DOC_SLUGS]).toEqual([...POLICY_DOCS]);
    for (const text of [...Object.values(POLICY_DOC_LABEL), ...Object.values(RECONSENT_UI)]) {
      for (const lang of LANGUAGES) expect(text[lang].length).toBeGreaterThan(0);
    }
  });
});
