/**
 * Pico Xpress credentials and environment (docs/pico-xpress-2026-11). Read from the environment only.
 * gokesari.com talks to Pico production (api.picoxpress.com) and nothing else; test.gokesari.com and local
 * development talk to Pico staging (dev-api.picoxpress.com) and never to production.
 */
import { deployedSiteKind, getEnv } from "@/lib/env";
import type { PicoEnv } from "@/server/db/pico-schema";

export const PICO_PRODUCTION_HOST = "api.picoxpress.com";
export const PICO_STAGING_HOST = "dev-api.picoxpress.com";

export interface PicoConfig {
  baseUrl: string;
  clientKey: string;
  apiKey: string;
  webhookToken: string | null;
  env: PicoEnv;
}

export type PicoConfigResult = { ok: true; config: PicoConfig } | { ok: false; problem: string };

/** Pure: checks a set of values against the site it runs on. */
export function checkPicoConfig(
  values: { baseUrl?: string; clientKey?: string; apiKey?: string; webhookToken?: string },
  site: "production" | "test" | "local",
): PicoConfigResult {
  if (!values.baseUrl || !values.clientKey || !values.apiKey) {
    return { ok: false, problem: "Pico Xpress is not configured on this server (PICO_BASE_URL, PICO_CLIENT_KEY, PICO_API_KEY)." };
  }
  let url: URL;
  try {
    url = new URL(values.baseUrl);
  } catch {
    return { ok: false, problem: "PICO_BASE_URL is not a valid URL." };
  }
  if (url.protocol !== "https:") return { ok: false, problem: "PICO_BASE_URL must use HTTPS." };
  const host = url.host.toLowerCase();
  if (host !== PICO_PRODUCTION_HOST && host !== PICO_STAGING_HOST) {
    return { ok: false, problem: `PICO_BASE_URL must be https://${PICO_PRODUCTION_HOST} or https://${PICO_STAGING_HOST}.` };
  }
  if (site === "production" && host !== PICO_PRODUCTION_HOST) {
    return { ok: false, problem: "gokesari.com must use Pico production (https://api.picoxpress.com), not the staging API." };
  }
  if (site !== "production" && host === PICO_PRODUCTION_HOST) {
    return { ok: false, problem: "Only gokesari.com may use Pico production; this site must use https://dev-api.picoxpress.com." };
  }
  return {
    ok: true,
    config: {
      baseUrl: `https://${host}`,
      clientKey: values.clientKey,
      apiKey: values.apiKey,
      webhookToken: values.webhookToken?.trim() ? values.webhookToken.trim() : null,
      env: host === PICO_PRODUCTION_HOST ? "PRODUCTION" : "STAGING",
    },
  };
}

export function picoConfig(): PicoConfigResult {
  const env = getEnv();
  return checkPicoConfig(
    { baseUrl: env.PICO_BASE_URL, clientKey: env.PICO_CLIENT_KEY, apiKey: env.PICO_API_KEY, webhookToken: env.PICO_WEBHOOK_TOKEN },
    deployedSiteKind(env),
  );
}

/** The Pico environment this site belongs to (for the AWB pool and shipment rows), even when not configured. */
export function picoEnvForSite(): PicoEnv {
  const r = picoConfig();
  if (r.ok) return r.config.env;
  return deployedSiteKind() === "production" ? "PRODUCTION" : "STAGING";
}
