import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { base64ToBase64Url, bytesToBase64Url } from "../pkce";

describe("PKCE helpers", () => {
  it("match RFC 7636 Appendix B", () => {
    const octets = new Uint8Array([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240,
      91, 88, 5, 88, 83, 132, 141, 121,
    ]);
    const verifier = bytesToBase64Url(octets);
    expect(verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    // expo-crypto returns standard base64; the website expects base64url.
    expect(base64ToBase64Url(createHash("sha256").update(verifier).digest("base64"))).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("agrees with Node's encoder for every length", () => {
    for (let length = 0; length < 40; length++) {
      const bytes = randomBytes(length);
      expect(bytesToBase64Url(new Uint8Array(bytes))).toBe(bytes.toString("base64url"));
    }
  });
});
