/** Billing v2 (docs/billing §9.7): the IRN of a credit note on an e-invoiced invoice. The shop's owner, or an admin. */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { creditNotes } from "@/server/db/schema";
import { requestCreditNoteEinvoice } from "@/server/gst/einvoice-extras";
import { requireFeature } from "@/server/services/feature-flags";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireUser();
  await requireFeature("einvoice");
  const id = z.string().uuid().parse((await context.params).id);
  const [note] = await db.select().from(creditNotes).where(eq(creditNotes.id, id));
  if (!note) throw notFound("Credit note");
  const { user } = await requireShopAccess(note.shopId, { anyPermission: PERMISSIONS.STATUTORY_MANAGE });
  return ok(await requestCreditNoteEinvoice(id, user));
});
