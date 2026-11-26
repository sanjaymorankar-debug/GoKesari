/** docs/referral-sharing-2026-11: link, channels and the pre-filled message (src/lib/referral-share.ts). */
import { describe, expect, it } from "vitest";

import { channelFromTag, channelHref, cleanShareCode, isShareChannel, referralLink, shareMessage, SHARE_CHANNELS } from "@/lib/referral-share";

describe("referral link", () => {
  it("is /r/<CODE> with the channel tag, hyphen kept", () => {
    expect(referralLink("https://gokesari.com/", "gkd-ab3x9k", "whatsapp")).toBe("https://gokesari.com/r/GKD-AB3X9K?c=wa");
    expect(referralLink("https://test.gokesari.com", "GK7HJ2MN")).toBe("https://test.gokesari.com/r/GK7HJ2MN");
    expect(cleanShareCode(" shop<script>ab ")).toBe("SHOPSCRIPTAB");
  });

  it("maps every channel to a tag and back", () => {
    for (const c of SHARE_CHANNELS) {
      const tag = new URL(referralLink("https://gokesari.com", "GKABCDEF", c)).searchParams.get("c");
      expect(channelFromTag(tag)).toBe(c);
    }
    expect(channelFromTag("nope")).toBeNull();
    expect(isShareChannel("sms")).toBe(true);
    expect(isShareChannel("fax")).toBe(false);
  });
});

describe("message", () => {
  const link = "https://gokesari.com/r/GKD-AB3X9K?c=wa";
  it("English then Hindi by default, with the code and link in both", () => {
    const m = shareMessage({ code: "gkd-ab3x9k", who: "Shree Traders", audience: "shop-owner", link });
    expect(m.startsWith("Register your shop on GoKesari with Shree Traders's referral code GKD-AB3X9K:")).toBe(true);
    expect(m).toContain("दुकान GoKesari पर रजिस्टर");
    expect(m.split(link)).toHaveLength(3);
  });
  it("Marathi for a Marathi speaker; customer wording for customers", () => {
    const m = shareMessage({ code: "GK7HJ2MN", who: "Asha", audience: "customer", link, lang: "mr" });
    expect(m).toContain("Asha invited you to GoKesari");
    expect(m).toContain("यांनी तुम्हाला GoKesari वर बोलावले");
  });
  it("channel links carry the message", () => {
    expect(channelHref("whatsapp", "hi there")).toBe("https://wa.me/?text=hi%20there");
    expect(channelHref("sms", "a&b")).toBe("sms:?&body=a%26b");
    expect(channelHref("email", "x", "Join")).toBe("mailto:?subject=Join&body=x");
  });
});
