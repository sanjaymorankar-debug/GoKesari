/**
 * TC-SEC-002 (QA run 24 Oct 2026, defect D-02): a malformed id in the URL —
 * "abc" where a uuid belongs — reached PostgreSQL as invalid input and came
 * back as a generic 500. It is now a 404: nothing by that id exists.
 */
import { describe, expect, it, vi } from "vitest";

import { isInvalidUuidInput, toClientError } from "@/lib/errors";

function pgError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

describe("malformed ids", () => {
  it("maps invalid uuid input, bare or wrapped by Drizzle, to 404", () => {
    const bare = pgError("22P02", 'invalid input syntax for type uuid: "abc"');
    const wrapped = new Error("Failed query: select ...", { cause: bare });
    for (const error of [bare, wrapped]) {
      expect(isInvalidUuidInput(error)).toBe(true);
      expect(toClientError(error)).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } });
    }
  });

  it("says plainly when every mailbox has used its quota (503, not a generic 500)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error("All 11 mailboxes have sent 90 e-mails in the last 24 hours."), { name: "MailboxesExhaustedError" });
    const result = toClientError(error);
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("RATE_LIMITED");
    expect(result.body.error.message).toMatch(/can't send e-mails right now/);
    spy.mockRestore();
  });

  it("leaves other database errors a generic 500", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const error of [
      pgError("22P02", 'invalid input syntax for type integer: "x"'),
      pgError("23505", "duplicate key value violates unique constraint"),
      new Error("boom"),
    ]) {
      expect(isInvalidUuidInput(error)).toBe(false);
      expect(toClientError(error).status).toBe(500);
    }
    spy.mockRestore();
  });
});
