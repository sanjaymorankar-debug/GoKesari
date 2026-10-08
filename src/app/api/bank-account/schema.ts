/** Shared body of PUT /api/bank-account and PUT /api/shops/{id}/bank-account. */
import { z } from "zod";

export const bankAccountSchema = z.object({
  method: z.enum(["BANK_ACCOUNT", "UPI"]),
  accountHolderName: z.string().max(120),
  accountNumber: z.string().max(30).nullish(),
  confirmAccountNumber: z.string().max(30).nullish(),
  ifsc: z.string().max(20).nullish(),
  upiId: z.string().max(300).nullish(),
});
