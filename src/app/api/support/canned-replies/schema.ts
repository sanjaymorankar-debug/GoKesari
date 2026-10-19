import { z } from "zod";

/** A canned reply as an admin enters it. Placeholders: {{ticketNumber}}, {{name}}, {{orderNumber}}. */
export const cannedSchema = z.object({
  title: z.string().min(2).max(120),
  body: z.string().min(5).max(5000),
  category: z.string().max(40).nullish(),
  active: z.boolean().optional(),
});
