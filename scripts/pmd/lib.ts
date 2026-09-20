/**
 * Shared helpers for the pmd CLI scripts.
 *
 * SAFETY: these scripts write data. They NEVER fall back to DATABASE_URL (which in
 * a developer's .env points at a hosted database). A target must be named explicitly
 * in PMD_DATABASE_URL, and a non-local host is refused unless PMD_ALLOW_REMOTE=1
 * is set on purpose. The app's .env is deliberately NOT loaded: it holds hosted-database
 * and payment credentials these tools have no business touching.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { createSql, type Sql } from "@/server/pmd/db";

export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function defaultSampleDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(base, "GokesariPmd", "samples");
}

export function defaultOutputDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(base, "GokesariPmd", "out");
}

/** Identifies the platform and gives a contact, as the polite client requires. Never a personal address. */
export function httpUserAgent(): string {
  return process.env.PMD_HTTP_USER_AGENT ?? "GokesariProductMaster/0.1 (+https://gokesari.com)";
}

export function describeTarget(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.username ? u.username + "@" : ""}${u.host}${u.pathname}`;
}

export function pmdDatabaseUrl(): string {
  const url = process.env.PMD_DATABASE_URL;
  if (!url) {
    throw new Error(
      "PMD_DATABASE_URL is not set. This tool deliberately does not fall back to DATABASE_URL, " +
        "so it can never write to an application database by accident.",
    );
  }
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && process.env.PMD_ALLOW_REMOTE !== "1") {
    throw new Error(
      `Refusing to write to non-local database host "${host}". ` +
        "Validate on a local database first; set PMD_ALLOW_REMOTE=1 only when you mean it.",
    );
  }
  return url;
}

export function connect(): Sql {
  return createSql(pmdDatabaseUrl());
}

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
