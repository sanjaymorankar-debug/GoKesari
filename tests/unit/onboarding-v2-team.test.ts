/** Onboarding v2 "My team" pure helpers (src/lib/onboarding-v2/team.ts). */
import { describe, expect, it } from "vitest";

import { maskPersonName, parseTeamContact, teamInviteLink, teamInviteMessage, teamInviteShareLinks } from "@/lib/onboarding-v2/team";
import { formatIstStamp } from "@/server/onboarding-v2/roles";
import { hashInviteToken } from "@/server/onboarding-v2/team";

describe("parseTeamContact: exact mobile or e-mail", () => {
  it("normalises Indian mobiles to +91", () => {
    for (const raw of ["9876543210", "+91 98765 43210", "+919876543210", "919876543210", "09876543210", "98765-43210"]) {
      expect(parseTeamContact(raw), raw).toEqual({ kind: "mobile", e164: "+919876543210" });
    }
  });
  it("lower-cases e-mails and refuses anything else", () => {
    expect(parseTeamContact(" Ramesh.K@Example.COM ")).toEqual({ kind: "email", email: "ramesh.k@example.com" });
    for (const raw of ["", "Ramesh", "12345", "5876543210", "a@b", "a b@c.com"]) expect(parseTeamContact(raw), raw).toBeNull();
  });
});

describe("maskPersonName", () => {
  it("keeps two letters of each word", () => {
    expect(maskPersonName("Ramesh Kumar")).toBe("Ra**** Ku***");
    expect(maskPersonName("Al")).toBe("A*");
    expect(maskPersonName("  ")).toBe("GoKesari customer");
    expect(maskPersonName(null)).toBe("GoKesari customer");
    expect(maskPersonName("Venkataramanan")).toBe("Ve******");
  });
});

describe("invite link and message", () => {
  it("builds /team/join/<token> and the WhatsApp / SMS / e-mail links", () => {
    const link = teamInviteLink("https://test.gokesari.com/", "tok_EN-123");
    expect(link).toBe("https://test.gokesari.com/team/join/tok_EN-123");
    const message = teamInviteMessage({ dealerName: "Shree Sai", role: "AGENT", link, expiresIst: "03 Dec 2026, 06.19 PM IST" });
    expect(message).toContain("as an agent");
    expect(message).toContain(link);
    const share = teamInviteShareLinks(message);
    expect(share.whatsapp.startsWith("https://wa.me/?text=")).toBe(true);
    expect(share.sms.startsWith("sms:?&body=")).toBe(true);
    expect(share.email).toContain("subject=Join%20my%20GoKesari%20team");
  });
  it("stores only a sha256 of the token, and shows times in IST", () => {
    expect(hashInviteToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(formatIstStamp(new Date("2026-11-26T12:49:00Z"))).toBe("26 Nov 2026, 06.19 PM IST");
  });
});
