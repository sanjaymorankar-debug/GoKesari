/**
 * The call sites' entry to system tickets (docs/flows-v3/wave1.md; flag flow_f17). Loads system-tickets.ts on
 * demand (no import cycle with the services that call it) and never throws: the calling flow is unaffected
 * whatever happens here. Call it after the caller's own transaction has committed.
 */
import type { SupportTicket } from "@/server/db/schema";
import type { SystemTicketInput, SystemTicketKind } from "./system-tickets";

export async function systemTicketHook(kind: SystemTicketKind, sourceRef: string, input: SystemTicketInput): Promise<SupportTicket | null> {
  try {
    const { openSystemTicket } = await import("./system-tickets");
    return await openSystemTicket(kind, sourceRef, input);
  } catch (error) {
    console.error("[helpdesk] system ticket hook failed", kind, error);
    return null;
  }
}
