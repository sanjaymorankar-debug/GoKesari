/**
 * docs/app-install-2026-10: the signed-in person's install-prompt record
 * (app_install_states, core). Declines are counted only; installs list the
 * platforms the prompt stops on for this account.
 */
import { eq, sql } from "drizzle-orm";

import type { InstallEvent, InstallPlatform } from "@/lib/app-install";
import { db } from "@/server/db";
import { appInstallStates } from "@/server/db/schema";

export interface AppInstallRecord {
  declineCount: number;
  lastDeclinedAt: string | null;
  installedPlatforms: InstallPlatform[];
}

const EMPTY: AppInstallRecord = { declineCount: 0, lastDeclinedAt: null, installedPlatforms: [] };

const PLATFORMS: readonly InstallPlatform[] = ["android", "ios", "desktop"];

function toRecord(row: typeof appInstallStates.$inferSelect | undefined): AppInstallRecord {
  if (!row) return EMPTY;
  return {
    declineCount: row.declineCount,
    lastDeclinedAt: row.lastDeclinedAt?.toISOString() ?? null,
    installedPlatforms: row.installedPlatforms.filter((p): p is InstallPlatform => (PLATFORMS as readonly string[]).includes(p)),
  };
}

export async function getAppInstallRecord(userId: string): Promise<AppInstallRecord> {
  const [row] = await db.select().from(appInstallStates).where(eq(appInstallStates.userId, userId)).limit(1);
  return toRecord(row);
}

/** Records "Not now", an install, or an uninstall the browser reported, for one platform. */
export async function recordAppInstallEvent(userId: string, event: InstallEvent, platform: InstallPlatform): Promise<AppInstallRecord> {
  const now = new Date();
  const insert = {
    userId,
    declineCount: event === "declined" ? 1 : 0,
    lastDeclinedAt: event === "declined" ? now : null,
    installedPlatforms: event === "installed" ? [platform] : [],
    lastInstalledAt: event === "installed" ? now : null,
    updatedAt: now,
  };
  // app_install_states is a core table: a targeted upsert is allowed there (CLAUDE.md limits it on seller tables).
  const set =
    event === "declined"
      ? { declineCount: sql`${appInstallStates.declineCount} + 1`, lastDeclinedAt: now, updatedAt: now }
      : event === "installed"
        ? {
            installedPlatforms: sql`(SELECT ARRAY(SELECT DISTINCT unnest(${appInstallStates.installedPlatforms} || ARRAY[${platform}]::text[]) ORDER BY 1))`,
            lastInstalledAt: now,
            updatedAt: now,
          }
        : { installedPlatforms: sql`array_remove(${appInstallStates.installedPlatforms}, ${platform})`, updatedAt: now };
  const [row] = await db
    .insert(appInstallStates)
    .values(insert)
    .onConflictDoUpdate({ target: appInstallStates.userId, set })
    .returning();
  return toRecord(row);
}
