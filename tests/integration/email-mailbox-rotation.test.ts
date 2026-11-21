/**
 * Mailbox rotation (owner, 21 Nov 2026): with EMAIL_POOL set, each mailbox
 * sends up to EMAIL_POOL_DAILY_CAP e-mails in a rolling 24 hours, then the
 * next one takes over; the main mailbox is last. Counts live in
 * email_mailbox_sends. The mail server itself is replaced by a fake.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const smtp = vi.hoisted(() => ({
  sent: [] as { user: string; from: string; replyTo?: string; to: string; subject: string }[],
  /** Per mailbox: what its next sends do. */
  refuse: new Map<string, Error & { code?: string; responseCode?: number; response?: string }>(),
}));

vi.mock("nodemailer", () => ({
  createTransport: (connection: string | { auth?: { user?: string } }) => {
    const user = typeof connection === "string" ? decodeURIComponent(new URL(connection).username) : (connection.auth?.user ?? "");
    return {
      sendMail: async (mail: { from: string; replyTo?: string; to: string; subject: string }) => {
        const refusal = smtp.refuse.get(user);
        if (refusal) throw refusal;
        smtp.sent.push({ user, from: mail.from, replyTo: mail.replyTo, to: mail.to, subject: mail.subject });
        return { accepted: [mail.to], rejected: [], pending: [] };
      },
    };
  },
}));

import { db } from "@/server/db";
import { emailMailboxSends } from "@/server/db/schema";
import { MailboxesExhaustedError, mailboxUsage, purgeOldMailboxSends, sendThroughMailboxes } from "@/server/email/mailbox-pool";
import { resetDatabase } from "../helpers/fixtures";

const env = {
  AUTH_EMAIL_FROM: "Gokesari <support@gokesari.com>",
  AUTH_EMAIL_SERVER: "smtps://support%40gokesari.com:main-secret@smtp.hostinger.com:465",
  EMAIL_POOL: "code1@gokesari.com code2@gokesari.com",
  EMAIL_POOL_PASSWORD: "pool-secret",
  EMAIL_POOL_DAILY_CAP: 2,
};
const mail = (n: number) => ({ to: `customer${n}@example.com`, subject: `Code ${n}`, text: `Your code is ${n}` });

function refusal(response: string, responseCode: number, code = "EENVELOPE") {
  return Object.assign(new Error(`Can't send mail - all recipients were rejected: ${response}`), { code, responseCode, response });
}

async function rows() {
  return db.select().from(emailMailboxSends).orderBy(emailMailboxSends.createdAt);
}

beforeEach(async () => {
  smtp.sent = [];
  smtp.refuse.clear();
  await resetDatabase();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("sendThroughMailboxes", () => {
  it("without EMAIL_POOL sends through AUTH_EMAIL_SERVER as before and counts nothing", async () => {
    const used = await sendThroughMailboxes(mail(1), { ...env, EMAIL_POOL: undefined });
    expect(used).toBe("support@gokesari.com");
    expect(smtp.sent).toEqual([{ user: "support@gokesari.com", from: "Gokesari <support@gokesari.com>", replyTo: undefined, to: "customer1@example.com", subject: "Code 1" }]);
    expect(await rows()).toEqual([]);
  });

  it("fills each mailbox up to the cap, then moves to the next, and the main mailbox last", async () => {
    const used: string[] = [];
    for (let n = 1; n <= 6; n++) used.push(await sendThroughMailboxes(mail(n), env));
    expect(used).toEqual(["code1@gokesari.com", "code1@gokesari.com", "code2@gokesari.com", "code2@gokesari.com", "support@gokesari.com", "support@gokesari.com"]);
    expect(smtp.sent[0]).toMatchObject({ from: "Gokesari <code1@gokesari.com>", replyTo: "support@gokesari.com" });
    expect(smtp.sent[4]).toMatchObject({ from: "Gokesari <support@gokesari.com>", replyTo: undefined });
    expect((await rows()).map((r) => [r.mailbox, r.outcome])).toEqual([
      ["code1@gokesari.com", "SENT"],
      ["code1@gokesari.com", "SENT"],
      ["code2@gokesari.com", "SENT"],
      ["code2@gokesari.com", "SENT"],
      ["support@gokesari.com", "SENT"],
      ["support@gokesari.com", "SENT"],
    ]);
    // Every mailbox full: the e-mail is not sent and the reason is logged.
    await expect(sendThroughMailboxes(mail(7), env)).rejects.toBeInstanceOf(MailboxesExhaustedError);
    expect(smtp.sent).toHaveLength(6);
  });

  it("counts a rolling 24 hours: a mailbox frees up as its sends pass the 24-hour mark", async () => {
    const now = new Date();
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
    await db.insert(emailMailboxSends).values([
      { mailbox: "code1@gokesari.com", outcome: "SENT", createdAt: hoursAgo(25) },
      { mailbox: "code1@gokesari.com", outcome: "SENT", createdAt: hoursAgo(23) },
    ]);
    expect((await mailboxUsage(["code1@gokesari.com"], now)).get("code1@gokesari.com")).toEqual({ sent: 1, lastRefusedAt: null });
    expect(await sendThroughMailboxes(mail(1), env, now)).toBe("code1@gokesari.com");
    expect(await sendThroughMailboxes(mail(2), env, now)).toBe("code2@gokesari.com");
  });

  it("moves on at once when the server refuses a mailbox, and leaves that mailbox alone for an hour", async () => {
    smtp.refuse.set("code1@gokesari.com", refusal("550 5.4.6 Daily sending limit exceeded", 550));
    expect(await sendThroughMailboxes(mail(1), env)).toBe("code2@gokesari.com");
    const refused = (await rows()).find((r) => r.outcome === "REFUSED");
    expect(refused).toMatchObject({ mailbox: "code1@gokesari.com" });
    expect(refused?.detail).toContain("limit: 550 5.4.6 Daily sending limit exceeded");

    // Paused: code1 is not even tried within the hour, though the server would take it now.
    smtp.refuse.clear();
    expect(await sendThroughMailboxes(mail(2), env)).toBe("code2@gokesari.com");
    expect(await sendThroughMailboxes(mail(3), env, new Date(Date.now() + 61 * 60_000))).toBe("code1@gokesari.com");
  });

  it("moves on from a mailbox whose password is wrong", async () => {
    smtp.refuse.set("code1@gokesari.com", refusal("535 5.7.8 Error: authentication failed", 535, "EAUTH"));
    expect(await sendThroughMailboxes(mail(1), env)).toBe("code2@gokesari.com");
    expect((await rows()).map((r) => [r.mailbox, r.outcome])).toEqual([
      ["code1@gokesari.com", "REFUSED"],
      ["code2@gokesari.com", "SENT"],
    ]);
  });

  it("tries the next mailbox on a connection problem without pausing the first", async () => {
    smtp.refuse.set("code1@gokesari.com", Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }));
    expect(await sendThroughMailboxes(mail(1), env)).toBe("code2@gokesari.com");
    expect((await rows()).map((r) => r.outcome)).toEqual(["SENT"]);
  });

  it("does not resend from another mailbox when the message itself is refused", async () => {
    smtp.refuse.set("code1@gokesari.com", refusal("550 5.1.1 Recipient address rejected", 550));
    await expect(sendThroughMailboxes(mail(1), env)).rejects.toMatchObject({ responseCode: 550 });
    expect(smtp.sent).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("fails with the last error when every mailbox is refused", async () => {
    for (const box of ["code1@gokesari.com", "code2@gokesari.com", "support@gokesari.com"]) smtp.refuse.set(box, refusal("554 sending quota exceeded", 554));
    await expect(sendThroughMailboxes(mail(1), env)).rejects.toMatchObject({ responseCode: 554 });
    expect((await rows()).map((r) => r.outcome)).toEqual(["REFUSED", "REFUSED", "REFUSED"]);
    await expect(sendThroughMailboxes(mail(2), env)).rejects.toBeInstanceOf(MailboxesExhaustedError);
  });
});

describe("purgeOldMailboxSends", () => {
  it("deletes counts older than two days and keeps the rest", async () => {
    const now = new Date();
    await db.insert(emailMailboxSends).values([
      { mailbox: "code1@gokesari.com", outcome: "SENT", createdAt: new Date(now.getTime() - 49 * 3_600_000) },
      { mailbox: "code1@gokesari.com", outcome: "SENT", createdAt: new Date(now.getTime() - 47 * 3_600_000) },
    ]);
    expect(await purgeOldMailboxSends(now)).toEqual({ deleted: 1 });
    expect(await db.select().from(emailMailboxSends).where(eq(emailMailboxSends.mailbox, "code1@gokesari.com"))).toHaveLength(1);
    expect(await purgeOldMailboxSends(now)).toEqual({ deleted: 0 });
  });
});
