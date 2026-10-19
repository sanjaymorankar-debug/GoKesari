/**
 * batch-2026-10 WS-D (F9.2.6, part): inventory sync is descoped — stock is the
 * shop owner's responsibility. Rule `inventorySync.enabled` (default OFF) stops
 * the integration-sync job, the automatic dispatch after an event and the
 * desktop connector's endpoints, and hides the connect screen. Nothing is
 * deleted: connections, item links, jobs and the code all stay, and switching
 * the rule on resumes everything where it stopped.
 */
import { AppError } from "@/lib/errors";
import { getRule } from "@/server/services/settings";

export const INVENTORY_SYNC_OFF_MESSAGE =
  "Inventory sync is switched off on GoKesari: stock is managed by each shop. Nothing was sent or changed.";

export async function inventorySyncEnabled(): Promise<boolean> {
  try {
    return (await getRule("inventorySync")).enabled;
  } catch (error) {
    console.error("[integrations] could not read rule inventorySync — treating as off", error);
    return false;
  }
}

/** 409 for the connector endpoints while the rule is off (the connector shows the message and waits). */
export async function assertInventorySyncEnabled(): Promise<void> {
  if (!(await inventorySyncEnabled())) throw new AppError("CONFLICT", INVENTORY_SYNC_OFF_MESSAGE, { reason: "INVENTORY_SYNC_DISABLED" });
}
