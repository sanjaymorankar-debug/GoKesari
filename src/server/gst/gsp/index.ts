/**
 * The configured GSP (GSP_PROVIDER, GSP_ENV), with the same production /
 * sandbox pairing check as KYC: a misconfiguration stops GST calls with a
 * clear error instead of quietly using the wrong system.
 */
import { getEnv, gspConfigProblem } from "@/lib/env";

import { createMockGsp } from "./mock";
import { GspError, type GspProvider } from "./types";

export * from "./types";

let override: GspProvider | null = null;
let mock: GspProvider | null = null;

/** Tests only. Pass null to restore. */
export function setGspProviderForTests(provider: GspProvider | null): void {
  override = provider;
}

export function getGspProvider(): GspProvider {
  if (override) return override;
  const env = getEnv();
  const problem = gspConfigProblem(env);
  if (problem) throw new GspError("NOT_CONFIGURED", problem);
  switch (env.GSP_PROVIDER) {
    case "mock":
      mock ??= createMockGsp();
      return mock;
  }
}
