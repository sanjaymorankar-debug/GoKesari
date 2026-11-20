/** GoKesari Health: a doctor's prescription templates and favourite medicines. */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { healthRxTemplates, type HealthRxTemplate } from "@/server/db/schema";
import { requireDoctorContext, type HealthActor } from "./access";
import { itemInput } from "./prescriptions";

export const templateInput = z.object({
  id: z.string().uuid().nullish(),
  kind: z.enum(["TEMPLATE", "FAVOURITE"]),
  name: z.string().trim().min(2).max(120),
  content: z.object({
    items: z.array(itemInput).max(40).default([]),
    advice: z.string().trim().max(4000).nullish(),
    investigations: z.array(z.object({ name: z.string().trim().min(2).max(200), note: z.string().trim().max(300).nullish() })).max(30).default([]),
    diagnoses: z.array(z.object({ code: z.string().trim().max(10).nullish(), text: z.string().trim().min(2).max(300) })).max(20).default([]),
  }),
});

export async function listTemplates(memberId: string, actor: HealthActor): Promise<HealthRxTemplate[]> {
  await requireDoctorContext(memberId, actor);
  return db.select().from(healthRxTemplates).where(eq(healthRxTemplates.memberId, memberId)).orderBy(asc(healthRxTemplates.kind), asc(healthRxTemplates.name));
}

export async function saveTemplate(memberId: string, raw: unknown, actor: HealthActor): Promise<HealthRxTemplate> {
  const input = templateInput.parse(raw);
  await requireDoctorContext(memberId, actor);
  const values = { memberId, kind: input.kind, name: input.name, content: input.content as unknown as Record<string, unknown>, updatedAt: new Date() };
  if (input.id) {
    const [u] = await db.update(healthRxTemplates).set(values).where(and(eq(healthRxTemplates.id, input.id), eq(healthRxTemplates.memberId, memberId))).returning();
    if (!u) throw notFound("Template");
    return u;
  }
  const [row] = await db.insert(healthRxTemplates).values(values).returning();
  return row;
}

export async function deleteTemplate(memberId: string, templateId: string, actor: HealthActor): Promise<void> {
  await requireDoctorContext(memberId, actor);
  await db.delete(healthRxTemplates).where(and(eq(healthRxTemplates.id, templateId), eq(healthRxTemplates.memberId, memberId)));
}
