/**
 * F13.1.2: which push provider runs, from rule `push` (provider: mock | expo)
 * and EXPO_ACCESS_TOKEN. The mock is refused on the production site, like the
 * SMS / WhatsApp mock: there, PUSH deliveries are skipped with the reason.
 */
import { getEnv, type ServerEnv } from "@/lib/env";
import type { RuleValue } from "@/server/config/rules";
import { createExpoPushProvider } from "./expo";
import { createMockPushProvider } from "./mock";
import type { PushProvider } from "./types";

function isProductionSite(env: ServerEnv): boolean {
  let host = "";
  try {
    host = env.AUTH_URL ? new URL(env.AUTH_URL).hostname.toLowerCase() : "";
  } catch {
    host = "";
  }
  const prodHost = env.KYC_PRODUCTION_HOST.toLowerCase();
  return host === prodHost || host === `www.${prodHost}`;
}

/** Why push must not send with these settings, or null. */
export function pushConfigProblem(rules: Pick<RuleValue<"push">, "provider">, env: ServerEnv = getEnv()): string | null {
  if (rules.provider === "mock" && isProductionSite(env)) {
    return "The mock push provider is not allowed on the production site (rule push.provider).";
  }
  return null;
}

export function getPushProvider(rules: Pick<RuleValue<"push">, "provider">, env: ServerEnv = getEnv()): PushProvider {
  if (rules.provider === "expo") return createExpoPushProvider({ accessToken: env.EXPO_ACCESS_TOKEN ?? null });
  return createMockPushProvider();
}
