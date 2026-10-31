/** 1.6.0: Aadhaar by DigiLocker — which links the app opens in the in-app browser, and how it reads the return. */
import { describe, expect, it } from "vitest";

import { buildBridgeScript } from "../bridge-script";
import { digilockerCallbackUrl, digilockerResult, isDigilockerUrl } from "../digilocker";

const SITE = "https://gokesari.com";

describe("1.6.0 — DigiLocker", () => {
  it("opens DigiLocker's own page and the site's mock consent page, nothing else", () => {
    expect(isDigilockerUrl("https://digilocker.meripehchaan.gov.in/public/oauth2/1/authorize?client_id=X", SITE)).toBe(true);
    expect(isDigilockerUrl("https://api.digilocker.gov.in/x", SITE)).toBe(true);
    expect(isDigilockerUrl(`${SITE}/kyc-mock/digilocker?session=mock-dl-1`, SITE)).toBe(true);
    expect(isDigilockerUrl("http://digilocker.meripehchaan.gov.in/", SITE)).toBe(false);
    expect(isDigilockerUrl("https://digilocker.meripehchaan.gov.in.evil.example/", SITE)).toBe(false);
    expect(isDigilockerUrl(`${SITE}/delivery-partner/kyc`, SITE)).toBe(false);
    expect(isDigilockerUrl("https://test.gokesari.com/kyc-mock/digilocker", SITE)).toBe(false);
    expect(isDigilockerUrl(42, SITE)).toBe(false);
  });

  it("reads the result the website's return link hands back", () => {
    expect(digilockerCallbackUrl("gokesari-preview")).toBe("gokesari-preview://digilocker-return");
    expect(digilockerResult("gokesari://digilocker-return?result=verified")).toBe("verified");
    expect(digilockerResult("gokesari://digilocker-return?result=failed")).toBe("failed");
    expect(digilockerResult("gokesari://digilocker-return?result=whatever")).toBe("unknown");
    expect(digilockerResult(null)).toBe("cancelled");
  });

  it("the page bridge offers openDigiLocker and says which app build it is", () => {
    const script = buildBridgeScript({ siteOrigin: SITE, token: "t", platform: "android", version: "1.6.0", scheme: "gokesari" });
    expect(script).toContain('openDigiLocker: function (url) { return request("digilocker.open", { url: String(url) }); }');
    expect(script).toContain('scheme: "gokesari"');
  });
});
