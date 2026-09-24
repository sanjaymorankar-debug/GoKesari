/** Email magic-link sign-in configuration (GS-001). */
import { describe, expect, it } from "vitest";

import { emailSignInMode, magicLinkEmail } from "@/server/auth-email";

describe("emailSignInMode", () => {
  it("is off without a sender address", () => {
    expect(emailSignInMode({ AUTH_EMAIL_FROM: undefined, AUTH_EMAIL_SERVER: "smtps://x", NODE_ENV: "production" })).toBe("disabled");
  });

  it("mails the link when an SMTP server is configured", () => {
    expect(emailSignInMode({ AUTH_EMAIL_FROM: "a@b.c", AUTH_EMAIL_SERVER: "smtps://x", NODE_ENV: "production" })).toBe("smtp");
  });

  it("prints the link to the console only outside production", () => {
    expect(emailSignInMode({ AUTH_EMAIL_FROM: "a@b.c", AUTH_EMAIL_SERVER: undefined, NODE_ENV: "development" })).toBe("console");
    expect(emailSignInMode({ AUTH_EMAIL_FROM: "a@b.c", AUTH_EMAIL_SERVER: undefined, NODE_ENV: "production" })).toBe("disabled");
  });
});

describe("magicLinkEmail", () => {
  it("includes the link and escapes it inside the HTML attribute", () => {
    const url = 'https://gokesari.com/api/auth/callback/email?token=a&email=x"y';
    const message = magicLinkEmail(url);
    expect(message.text).toContain(url);
    expect(message.html).toContain("token=a&amp;email=x&quot;y");
    expect(message.html).not.toContain('x"y');
  });
});
