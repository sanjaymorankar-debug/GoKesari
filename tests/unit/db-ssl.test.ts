/**
 * The app's main database client (src/server/db/index.ts) takes its TLS from the
 * URL's sslmode. GoKesari's own database server is reached with
 * sslmode=verify-full, which must make postgres-js check the server's
 * certificate ("verify-full"); Neon's sslmode=require only encrypts, as before.
 */
import { describe, expect, it } from "vitest";

import { resolveSsl } from "@/server/db";

const base = "postgresql://gokesari_app:secret@db.gokesari.com:5432/gokesari";

describe("resolveSsl (main database client)", () => {
  it.each([
    ["no sslmode", "", false],
    ["sslmode=disable", "?sslmode=disable", false],
    ["sslmode=require (Neon)", "?sslmode=require", "require"],
    ["sslmode=prefer", "?sslmode=prefer", "require"],
    ["sslmode=verify-full", "?sslmode=verify-full", "verify-full"],
    ["sslmode=verify-ca (checked as strictly)", "?sslmode=verify-ca", "verify-full"],
    ["verify-full beside channel_binding", "?channel_binding=require&sslmode=verify-full", "verify-full"],
  ])("%s", (_label, query, expected) => {
    expect(resolveSsl(`${base}${query}`)).toBe(expected);
  });

  it("treats a URL it cannot read as no TLS, as before", () => {
    expect(resolveSsl("not a url")).toBe(false);
  });
});
