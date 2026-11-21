/**
 * Mailbox rotation (owner, 21 Nov 2026): which mailboxes are configured, which
 * may send now, and how a refusal from the mail server is read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifySendError, configuredMailboxes, parseSender, REFUSAL_PAUSE_MS, usableMailboxes } from "@/server/email/mailbox-pool";

const base = {
  AUTH_EMAIL_FROM: "Gokesari <support@gokesari.com>",
  AUTH_EMAIL_SERVER: "smtps://support%40gokesari.com:main-secret@smtp.hostinger.com:465",
  EMAIL_POOL: undefined as string | undefined,
  EMAIL_POOL_PASSWORD: undefined as string | undefined,
  EMAIL_POOL_DAILY_CAP: 90,
};

afterEach(() => vi.restoreAllMocks());

describe("parseSender", () => {
  it("reads the display name and the address", () => {
    expect(parseSender("Gokesari <no-reply@gokesari.com>")).toEqual({ name: "Gokesari", address: "no-reply@gokesari.com" });
    expect(parseSender('"GoKesari Team" <a@b.com>')).toEqual({ name: "GoKesari Team", address: "a@b.com" });
    expect(parseSender("a@b.com")).toEqual({ name: null, address: "a@b.com" });
    expect(parseSender(undefined)).toEqual({ name: null, address: null });
  });
});

describe("configuredMailboxes", () => {
  it("is just the main mailbox without EMAIL_POOL", () => {
    const boxes = configuredMailboxes(base);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ address: "support@gokesari.com", connection: base.AUTH_EMAIL_SERVER, from: base.AUTH_EMAIL_FROM, main: true });
    expect(configuredMailboxes({ ...base, EMAIL_POOL: " , " })).toHaveLength(1);
  });

  it("is nothing without AUTH_EMAIL_SERVER", () => {
    expect(configuredMailboxes({ ...base, AUTH_EMAIL_SERVER: undefined, EMAIL_POOL: "code1@gokesari.com" })).toEqual([]);
  });

  it("puts the pool mailboxes first, in order, and the main mailbox last", () => {
    const boxes = configuredMailboxes({ ...base, EMAIL_POOL: "Code1@gokesari.com, code2@gokesari.com\ncode3@gokesari.com", EMAIL_POOL_PASSWORD: "pool-secret" });
    expect(boxes.map((b) => b.address)).toEqual(["code1@gokesari.com", "code2@gokesari.com", "code3@gokesari.com", "support@gokesari.com"]);
    expect(boxes[0]).toEqual({
      address: "code1@gokesari.com",
      connection: { host: "smtp.hostinger.com", port: 465, secure: true, auth: { user: "code1@gokesari.com", pass: "pool-secret" } },
      from: "Gokesari <code1@gokesari.com>",
      replyTo: "support@gokesari.com",
      main: false,
    });
    expect(boxes[3].main).toBe(true);
  });

  it("accepts a full SMTP URL with its own password", () => {
    const url = "smtps://code9%40gokesari.com:own%23secret@smtp.hostinger.com:465";
    const boxes = configuredMailboxes({ ...base, EMAIL_POOL: url });
    expect(boxes[0]).toMatchObject({ address: "code9@gokesari.com", connection: url, from: "Gokesari <code9@gokesari.com>" });
  });

  it("takes port and TLS from AUTH_EMAIL_SERVER", () => {
    const boxes = configuredMailboxes({ ...base, AUTH_EMAIL_SERVER: "smtp://support%40gokesari.com:x@smtp.example.com", EMAIL_POOL: "code1@gokesari.com", EMAIL_POOL_PASSWORD: "p" });
    expect(boxes[0].connection).toMatchObject({ host: "smtp.example.com", port: 587, secure: false });
  });

  it("skips duplicates and the main mailbox named again", () => {
    const boxes = configuredMailboxes({ ...base, EMAIL_POOL: "code1@gokesari.com code1@gokesari.com support@gokesari.com", EMAIL_POOL_PASSWORD: "p" });
    expect(boxes.map((b) => b.address)).toEqual(["code1@gokesari.com", "support@gokesari.com"]);
  });

  it("skips plain addresses without EMAIL_POOL_PASSWORD, and anything else it cannot use, without naming a password", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boxes = configuredMailboxes({ ...base, EMAIL_POOL: "code1@gokesari.com not-an-address smtps://smtp.hostinger.com:465" });
    expect(boxes.map((b) => b.address)).toEqual(["support@gokesari.com"]);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain("main-secret");
  });

  it("uses GoKesari as the name when AUTH_EMAIL_FROM has none", () => {
    const boxes = configuredMailboxes({ ...base, AUTH_EMAIL_FROM: "support@gokesari.com", EMAIL_POOL: "code1@gokesari.com", EMAIL_POOL_PASSWORD: "p" });
    expect(boxes[0].from).toBe("GoKesari <code1@gokesari.com>");
  });
});

describe("usableMailboxes", () => {
  const boxes = configuredMailboxes({ ...base, EMAIL_POOL: "code1@gokesari.com code2@gokesari.com", EMAIL_POOL_PASSWORD: "p" });
  const now = new Date("2026-11-21T10:00:00Z");

  it("keeps the order and drops mailboxes at the cap", () => {
    const usage = new Map([["code1@gokesari.com", { sent: 90, lastRefusedAt: null }], ["code2@gokesari.com", { sent: 89, lastRefusedAt: null }]]);
    expect(usableMailboxes(boxes, usage, 90, now).map((b) => b.address)).toEqual(["code2@gokesari.com", "support@gokesari.com"]);
  });

  it("pauses a refused mailbox for an hour", () => {
    const refused = (msAgo: number) => new Map([["code1@gokesari.com", { sent: 3, lastRefusedAt: new Date(now.getTime() - msAgo) }]]);
    expect(usableMailboxes(boxes, refused(REFUSAL_PAUSE_MS - 1000), 90, now)[0].address).toBe("code2@gokesari.com");
    expect(usableMailboxes(boxes, refused(REFUSAL_PAUSE_MS), 90, now)[0].address).toBe("code1@gokesari.com");
  });

  it("is empty when every mailbox is full", () => {
    const full = new Map(boxes.map((b) => [b.address, { sent: 90, lastRefusedAt: null }]));
    expect(usableMailboxes(boxes, full, 90, now)).toEqual([]);
  });
});

describe("classifySendError", () => {
  it("reads a sending limit", () => {
    expect(classifySendError({ code: "EENVELOPE", responseCode: 550, response: "550 5.4.6 Daily sending limit exceeded" })).toBe("limit");
    expect(classifySendError({ code: "EENVELOPE", responseCode: 554, response: "554 Message rejected: quota reached" })).toBe("limit");
    expect(classifySendError({ code: "EMESSAGE", responseCode: 451, response: "451 4.7.1 Too many messages, slow down" })).toBe("limit");
    expect(classifySendError({ code: "EENVELOPE", responseCode: 451, response: "451 4.7.1 Try again later" })).toBe("limit");
  });

  it("reads a wrong password", () => {
    expect(classifySendError({ code: "EAUTH", responseCode: 535, response: "535 5.7.8 Authentication failed" })).toBe("auth");
  });

  it("reads a connection problem", () => {
    expect(classifySendError({ code: "ETIMEDOUT", message: "Connection timeout" })).toBe("connection");
    expect(classifySendError({ code: "ECONNECTION", message: "connect ECONNREFUSED" })).toBe("connection");
    expect(classifySendError({ responseCode: 421, response: "421 Service not available" })).toBe("connection");
  });

  it("leaves a problem with the message itself alone", () => {
    expect(classifySendError({ code: "EENVELOPE", responseCode: 550, response: "550 5.1.1 Recipient address rejected" })).toBe("message");
    expect(classifySendError({ code: "EENVELOPE", responseCode: 552, response: "552 5.3.4 Message size exceeds fixed limit" })).toBe("message");
    expect(classifySendError(new Error("boom"))).toBe("message");
    expect(classifySendError(undefined)).toBe("message");
  });
});
