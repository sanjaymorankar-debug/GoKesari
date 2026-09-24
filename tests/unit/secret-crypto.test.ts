/**
 * SEC-02 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): the PAN helper is
 * generalised so delivery-partner KYC/bank details can reuse it. The PAN
 * functions must keep producing and reading exactly the same format —
 * ciphertext written by one has to be readable by the other.
 */
import { describe, expect, it } from "vitest";

import { decryptPan, decryptSecret, encryptPan, encryptSecret } from "@/lib/pan-crypto";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips, including non-ASCII text", () => {
    for (const value of ["000123456789", "HDFC0001234", "Ravi Kumar", "श्रीमती कुमारी"]) {
      expect(decryptSecret(encryptSecret(value))).toBe(value);
    }
  });

  it("uses a fresh IV each time, so equal inputs give different ciphertext", () => {
    expect(encryptSecret("000123456789")).not.toBe(encryptSecret("000123456789"));
  });

  it("does not contain the plaintext", () => {
    expect(encryptSecret("000123456789")).not.toContain("000123456789");
  });

  it("shares its key and wire format with the PAN helpers", () => {
    expect(decryptPan(encryptSecret("ABCDE1234F"))).toBe("ABCDE1234F");
    expect(decryptSecret(encryptPan("ABCDE1234F"))).toBe("ABCDE1234F");
  });

  it("rejects ciphertext that has been tampered with", () => {
    const raw = Buffer.from(encryptSecret("000123456789"), "base64");
    raw[raw.length - 1] ^= 0x01;
    expect(() => decryptSecret(raw.toString("base64"))).toThrow();
  });
});
