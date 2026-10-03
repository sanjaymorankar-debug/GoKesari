/**
 * The one place a return's status changes. Every move is checked against
 * RETURN_TRANSITIONS, guarded against a concurrent change (the UPDATE names
 * the status it expects), written to return_status_history, and audited.
 */
import { and, eq } from "drizzle-orm";

import { AppError, conflict } from "@/lib/errors";
import {
  RETURN_STATUS_LABELS,
  RETURN_TRANSITIONS,
  type ReturnStatus,
} from "@/lib/return-states";
import type { DbClient } from "@/server/db";
import {
  returnRequests,
  returnStatusHistory,
  type ReturnRequest,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { updateReturning } from "@/server/db/returning";

export interface ReturnActor {
  id: string | null;
  role: UserRole | null;
}

export async function transitionReturn(
  tx: DbClient,
  ret: Pick<ReturnRequest, "id" | "status">,
  to: ReturnStatus,
  actor: ReturnActor,
  note?: string | null,
  extra: Partial<typeof returnRequests.$inferInsert> = {},
): Promise<ReturnRequest> {
  const from = ret.status as ReturnStatus;
  if (!RETURN_TRANSITIONS[from].includes(to)) {
    throw new AppError(
      "INVALID_STATE_TRANSITION",
      `A return that is "${RETURN_STATUS_LABELS[from]}" cannot move to "${RETURN_STATUS_LABELS[to]}".`,
    );
  }
  const [updated] = await updateReturning(
    tx,
    returnRequests,
    { ...extra, status: to, updatedAt: new Date() },
    and(eq(returnRequests.id, ret.id), eq(returnRequests.status, from)),
  );
  if (!updated)
    throw conflict(
      "This return was just changed by someone else. Refresh and try again.",
    );

  await tx.insert(returnStatusHistory).values({
    returnId: ret.id,
    fromStatus: from,
    toStatus: to,
    changedBy: actor.id,
    changedByRole: actor.role,
    note: note?.trim() || null,
  });
  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.RETURN_STATUS_CHANGED,
      entityType: "return_request",
      entityId: ret.id,
      previousValue: { status: from },
      newValue: { status: to, note: note ?? null },
    },
    tx,
  );
  return updated;
}
