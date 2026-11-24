/**
 * Tax register (docs/tax-register/README.md): questions for the CA. The Accountant (or an admin)
 * adds an item, writes the answer from the CA's advice and submits it; the CA approves (never an
 * answer they wrote) or sends it back with a note. Each item names the switches and settings it
 * holds back; a switch is "cleared by the CA" once all its items are approved. Nothing is switched
 * on here. The question wording is loaded from the owner's file (scripts/tax-register/load-ca-items.ts),
 * never kept in the repository.
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { caActionItemNotes, caActionItems, CA_ITEM_PRIORITIES, type CaActionItem, type CaActionItemNote } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import type { Actor } from "./changes";
import { decisionRefusal, nextCaItemStatus, switchClearance, type CaItemAction, type SwitchClearance } from "./rules";

const blocksSchema = z.array(z.string().trim().regex(/^[A-Za-z0-9_.:/-]{2,80}$/, "Switch keys: letters, digits and _ . : / -")).max(30);

export const caItemInput = z.object({
  ref: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, "Ref: capital letters, digits and dashes (e.g. GST-01)"),
  area: z.string().trim().min(2).max(40).default("GST"),
  title: z.string().trim().min(3).max(200),
  question: z.string().trim().min(5).max(5000),
  blocks: blocksSchema.default([]),
  priority: z.enum(CA_ITEM_PRIORITIES).default("NORMAL"),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});
export type CaItemInput = z.input<typeof caItemInput>;

export const caItemPatch = caItemInput.omit({ ref: true }).partial().extend({ answer: z.string().trim().max(10_000).nullish() });

function requireMaker(actor: Actor) {
  if (!can(actor.role, PERMISSIONS.TAX_PARAM_PROPOSE)) throw forbidden("Only the Accountant or an admin adds and answers CA items.");
}
function requireViewer(actor: Actor) {
  if (!can(actor.role, PERMISSIONS.TAX_PARAM_PROPOSE) && !can(actor.role, PERMISSIONS.TAX_PARAM_APPROVE)) throw forbidden("Only the Accountant, the CA or an admin sees CA items.");
}

async function note(itemId: string, actor: Actor, kind: string, body: string, client: Pick<typeof db, "insert"> = db) {
  await client.insert(caActionItemNotes).values({ itemId, authorId: actor.id, authorRole: actor.role, kind, body });
}

export interface CaItemView extends CaActionItem {
  notes: CaActionItemNote[];
}

export async function listCaItems(actor: Actor): Promise<{ items: CaItemView[]; switches: SwitchClearance[] }> {
  requireViewer(actor);
  const items = await db.select().from(caActionItems).orderBy(asc(caActionItems.ref));
  const notes = await db.select().from(caActionItemNotes).orderBy(asc(caActionItemNotes.createdAt));
  const byItem = new Map<string, CaActionItemNote[]>();
  for (const n of notes) byItem.set(n.itemId, [...(byItem.get(n.itemId) ?? []), n]);
  return { items: items.map((i) => ({ ...i, notes: byItem.get(i.id) ?? [] })), switches: switchClearance(items) };
}

/** Switch clearance only (for the admin screens). */
export async function caSwitchClearance(): Promise<SwitchClearance[]> {
  const items = await db.select({ ref: caActionItems.ref, status: caActionItems.status, blocks: caActionItems.blocks }).from(caActionItems);
  return switchClearance(items);
}

export async function createCaItem(input: CaItemInput, actor: Actor): Promise<CaActionItem> {
  requireMaker(actor);
  const v = caItemInput.parse(input);
  const [clash] = await db.select({ id: caActionItems.id }).from(caActionItems).where(eq(caActionItems.ref, v.ref));
  if (clash) throw conflict(`An item ${v.ref} already exists.`);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(caActionItems)
      .values({ ref: v.ref, area: v.area, title: v.title, question: v.question, blocks: v.blocks, priority: v.priority, dueOn: v.dueOn ?? null, createdBy: actor.id, updatedBy: actor.id })
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CA_ITEM_CHANGED, entityType: "ca_action_item", entityId: row.id, newValue: { event: "CREATED", ref: row.ref } }, tx);
    return row;
  });
}

/**
 * The Accountant edits an item or its answer. Changing the answer of an approved item withdraws
 * the approval: it goes back to the CA as SUBMITTED.
 */
export async function updateCaItem(id: string, patch: z.input<typeof caItemPatch>, actor: Actor): Promise<CaActionItem> {
  requireMaker(actor);
  const v = caItemPatch.parse(patch);
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(caActionItems).where(eq(caActionItems.id, id)).for("update");
    if (!cur) throw notFound("CA item");
    if (cur.status === "CLOSED") throw conflict("Reopen the item first.");
    const answerChanged = v.answer !== undefined && (v.answer ?? null) !== (cur.answer ?? null);
    const status = answerChanged && cur.status === "APPROVED" ? "SUBMITTED" : cur.status;
    const [row] = await tx
      .update(caActionItems)
      .set({
        ...(v.area !== undefined ? { area: v.area } : {}),
        ...(v.title !== undefined ? { title: v.title } : {}),
        ...(v.question !== undefined ? { question: v.question } : {}),
        ...(v.blocks !== undefined ? { blocks: v.blocks } : {}),
        ...(v.priority !== undefined ? { priority: v.priority } : {}),
        ...(v.dueOn !== undefined ? { dueOn: v.dueOn ?? null } : {}),
        ...(answerChanged ? { answer: v.answer ?? null, answeredBy: actor.id, answeredAt: new Date() } : {}),
        ...(status !== cur.status ? { status, approvedBy: null, approvedAt: null } : {}),
        updatedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(eq(caActionItems.id, id))
      .returning();
    if (status !== cur.status) await note(id, actor, "REOPENED", "Answer changed after approval: back with the CA.", tx);
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CA_ITEM_CHANGED, entityType: "ca_action_item", entityId: id, previousValue: { status: cur.status, answer: cur.answer, blocks: cur.blocks }, newValue: { event: "EDITED", status: row.status, answer: row.answer, blocks: row.blocks } },
      tx,
    );
    return row;
  });
}

/** SUBMIT (Accountant), APPROVE / SEND_BACK (the CA, never their own answer), CLOSE / REOPEN (Accountant or admin). */
export async function actOnCaItem(id: string, action: CaItemAction, actor: Actor, text?: string | null): Promise<CaActionItem> {
  const body = text?.trim() ?? "";
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(caActionItems).where(eq(caActionItems.id, id)).for("update");
    if (!cur) throw notFound("CA item");
    if (action === "APPROVE" || action === "SEND_BACK") {
      const refusal = decisionRefusal(actor, cur.answeredBy);
      if (refusal) throw forbidden(refusal);
      if (action === "SEND_BACK" && body.length < 3) throw validationFailed("Say what is missing.");
    } else requireMaker(actor);
    if (action === "SUBMIT" && !(cur.answer ?? "").trim()) throw validationFailed("Write the answer first.");
    if ((action === "CLOSE" || action === "REOPEN") && body.length < 3) throw validationFailed("Give a reason.");
    const next = nextCaItemStatus(cur.status, action);
    if (!next) throw conflict(`An item that is ${cur.status.toLowerCase().replace("_", " ")} cannot be ${action.toLowerCase().replace("_", " ")}.`);
    const [row] = await tx
      .update(caActionItems)
      .set({
        status: next,
        ...(action === "APPROVE" ? { approvedBy: actor.id, approvedAt: new Date() } : {}),
        ...(action === "SEND_BACK" || action === "REOPEN" ? { approvedBy: null, approvedAt: null } : {}),
        updatedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(and(eq(caActionItems.id, id), eq(caActionItems.status, cur.status)))
      .returning();
    const kinds: Record<CaItemAction, string> = { SUBMIT: "SUBMITTED", APPROVE: "APPROVED", SEND_BACK: "SENT_BACK", CLOSE: "CLOSED", REOPEN: "REOPENED" };
    await note(id, actor, kinds[action], body || kinds[action].toLowerCase().replace("_", " "), tx);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CA_ITEM_CHANGED, entityType: "ca_action_item", entityId: id, previousValue: { status: cur.status }, newValue: { event: action, status: next, note: body || null } }, tx);
    return row;
  });
}

export async function addCaItemNote(id: string, text: string, actor: Actor): Promise<void> {
  requireViewer(actor);
  const body = text.trim();
  if (body.length < 2 || body.length > 5000) throw validationFailed("A note is 2 to 5,000 characters.");
  const [cur] = await db.select({ id: caActionItems.id }).from(caActionItems).where(eq(caActionItems.id, id));
  if (!cur) throw notFound("CA item");
  await note(id, actor, "NOTE", body);
}

/**
 * Loads items from the owner's file: new refs are added, existing refs are left as they are
 * (an item already being worked on is never overwritten). Returns what was added and skipped.
 */
export async function importCaItems(items: CaItemInput[], actor: Actor): Promise<{ added: string[]; skipped: string[] }> {
  requireMaker(actor);
  const parsed = z.array(caItemInput).min(1).max(500).parse(items);
  const added: string[] = [];
  const skipped: string[] = [];
  for (const it of parsed) {
    const [clash] = await db.select({ id: caActionItems.id }).from(caActionItems).where(eq(caActionItems.ref, it.ref));
    if (clash) skipped.push(it.ref);
    else {
      await createCaItem(it, actor);
      added.push(it.ref);
    }
  }
  return { added, skipped };
}
