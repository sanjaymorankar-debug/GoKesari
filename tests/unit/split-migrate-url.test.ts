/**
 * The migration scripts open databases straight from their URLs. A Neon URL
 * carries channel_binding=require (libpq-only: postgres.js would send it as a
 * session setting the server refuses), and a secret may be saved with a
 * trailing newline — either used to stop every migration on a split site.
 */
import { describe, expect, it } from "vitest";

import { cleanDatabaseUrl, LIBPQ_ONLY_PARAMS } from "../../scripts/split-migrate.mjs";

describe("cleanDatabaseUrl", () => {
  it("drops libpq-only settings and keeps the rest", () => {
    const url = "postgresql://u:p%40ss@ep-x.c-4.aws.neon.tech/gokesari_seller?sslmode=require&channel_binding=require";
    const clean = new URL(cleanDatabaseUrl(url));
    expect(clean.searchParams.get("sslmode")).toBe("require");
    expect(clean.searchParams.has("channel_binding")).toBe(false);
    expect(clean.password).toBe("p%40ss");
    expect(clean.pathname).toBe("/gokesari_seller");
  });

  it("trims a trailing newline from a pasted secret", () => {
    expect(cleanDatabaseUrl("postgresql://u:p@host:5432/db?sslmode=require&channel_binding=require\n")).toBe("postgresql://u:p@host:5432/db?sslmode=require");
    expect(cleanDatabaseUrl("  postgresql://u:p@localhost:5432/db\r\n")).toBe("postgresql://u:p@localhost:5432/db");
  });

  it("leaves something that is not a URL as it was (trimmed)", () => {
    expect(cleanDatabaseUrl(" not a url ")).toBe("not a url");
  });

  it("drops the same settings as the split tools' connect()", () => {
    expect(LIBPQ_ONLY_PARAMS).toContain("channel_binding");
    expect(LIBPQ_ONLY_PARAMS).toContain("gssencmode");
  });
});
