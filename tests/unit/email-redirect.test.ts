/**
 * Test site mail (owner, 20 Nov 2026): with EMAIL_REDIRECT_TO set, every e-mail
 * except a sign-in code goes to one test inbox, naming who it was for. Never on
 * gokesari.com.
 */
import { describe, expect, it, vi } from "vitest";

import { emailRedirectTarget, redirectedEmail } from "@/server/email/transport";

const staging = { EMAIL_REDIRECT_TO: "testing@gokesari.com", NODE_ENV: "production", AUTH_URL: "https://test.gokesari.com", KYC_PRODUCTION_HOST: "gokesari.com" } as const;
const production = { ...staging, AUTH_URL: "https://gokesari.com" } as const;
const message = { to: "sanjay+gk-shop@example.com", subject: "New order — Gokesari", text: "Order DB-1 — 1 item.", html: "<p>Order DB-1</p>" };

describe("emailRedirectTarget", () => {
  it("is the test inbox on the test site", () => {
    expect(emailRedirectTarget(staging)).toBe("testing@gokesari.com");
  });

  it("is off when unset or empty", () => {
    expect(emailRedirectTarget({ ...staging, EMAIL_REDIRECT_TO: undefined })).toBeNull();
    expect(emailRedirectTarget({ ...staging, EMAIL_REDIRECT_TO: "" })).toBeNull();
  });

  it("is ignored on gokesari.com, and on a production build with no AUTH_URL", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(emailRedirectTarget(production)).toBeNull();
    expect(emailRedirectTarget({ ...production, AUTH_URL: "https://www.gokesari.com" })).toBeNull();
    expect(emailRedirectTarget({ ...staging, AUTH_URL: undefined })).toBeNull();
    warn.mockRestore();
  });
});

describe("redirectedEmail", () => {
  it("readdresses the message to the test inbox and names the intended recipient", () => {
    const sent = redirectedEmail(message, staging);
    expect(sent.to).toBe("testing@gokesari.com");
    expect(sent.subject).toBe("[for sanjay+gk-shop@example.com] New order — Gokesari");
    expect(sent.text).toBe("Test site: this e-mail was meant for sanjay+gk-shop@example.com.\n\nOrder DB-1 — 1 item.");
    expect(sent.html).toContain("meant for sanjay+gk-shop@example.com.");
    expect(sent.html).toContain("<p>Order DB-1</p>");
  });

  it("escapes the address inside the HTML note", () => {
    const sent = redirectedEmail({ ...message, to: 'a"<b>@example.com' }, staging);
    expect(sent.html).toContain("a&quot;&lt;b&gt;@example.com");
    expect(sent.html).not.toContain("<b>@");
  });

  it("leaves a sign-in code with its own address", () => {
    expect(redirectedEmail({ ...message, keepRecipient: true }, staging)).toEqual({ ...message, keepRecipient: true });
  });

  it("changes nothing when it is already for the test inbox, when off, or on production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(redirectedEmail({ ...message, to: "Testing@GoKesari.com" }, staging)).toEqual({ ...message, to: "Testing@GoKesari.com" });
    expect(redirectedEmail(message, { ...staging, EMAIL_REDIRECT_TO: undefined })).toBe(message);
    expect(redirectedEmail(message, production)).toBe(message);
    warn.mockRestore();
  });

  it("keeps a text-only message text-only", () => {
    expect(redirectedEmail({ ...message, html: undefined }, staging).html).toBeUndefined();
  });
});
