/** RBAC v2 Phase 6 — Operations (docs/rbac/06-operations.md). Behind flag rbac_v2_operations. */
export * from "./access";
export * from "./assists";
export * from "./reports";
export * from "./tasks";

import { registerOpsTaskLookup } from "@/server/rbac-support/desk";
import { getOpsTask } from "./tasks";

// Phase 7 handover (other session): lets the Support desk read a task to scope and link a ticket.
registerOpsTaskLookup(getOpsTask);
