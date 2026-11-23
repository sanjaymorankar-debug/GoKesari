/** RBAC v2 Phase 3: request shapes shared by the accounting routes. */
import { z } from "zod";

export const journalLineSchema = z.object({
  accountCode: z.string().trim().min(1).max(40),
  accountName: z.string().trim().min(1).max(200),
  debitPaise: z.number().int().min(0).max(100_000_000_000).optional(),
  creditPaise: z.number().int().min(0).max(100_000_000_000).optional(),
  memo: z.string().trim().max(300).nullish(),
});

export const journalSchema = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  narration: z.string().trim().min(3).max(500),
  lines: z.array(journalLineSchema).min(2).max(200),
});
