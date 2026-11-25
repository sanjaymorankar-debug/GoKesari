/**
 * Registration subscription settings (0206) — admin only, each change audited (setting.changed):
 * validity months, grace days, reminders / online renewal switches (rule shopMembership) and the reminder
 * schedule, link validity, CC list, renewal fee per shop type and commission on renewals
 * (rule shopRegistrationSubscription).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { getRule, setRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireRole("ADMIN");
  const [membership, subscription] = await Promise.all([getRule("shopMembership"), getRule("shopRegistrationSubscription")]);
  return ok({ membership, subscription });
});

const body = z.object({
  membership: z
    .object({
      periodMonths: z.number().int().min(1).max(60),
      graceDays: z.number().int().min(0).max(90),
      reminderDays: z.number().int().min(0).max(90),
      remindersEnabled: z.boolean(),
      renewalCheckoutEnabled: z.boolean(),
      renewalWindowDays: z.number().int().min(0).max(365),
    })
    .partial()
    .optional(),
  subscription: z
    .object({
      reminderHourIst: z.number().int().min(0).max(23),
      unpaidReminderDays: z.array(z.number().int().min(0).max(365)).max(20),
      unpaidRepeatEveryDays: z.number().int().min(0).max(90),
      expiryReminderDays: z.array(z.number().int().min(0).max(365)).max(40),
      graceDaily: z.boolean(),
      autoCreateLink: z.boolean(),
      paymentLinkValidityDays: z.number().int().min(1).max(30),
      ccEmails: z.array(z.string().email()).max(10),
      renewalFeeByShopType: z.record(z.string().max(60), z.number().int().min(0).max(100_000_000)),
      payCommissionOnRenewals: z.boolean(),
    })
    .partial()
    .optional(),
});

export const PUT = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  const input = await parseBody(request, body);
  const actor = { id: user.id, role: user.role };
  // Merged over the stored values, so a partial form never resets the switches it does not show.
  const membership = input.membership ? await setRule("shopMembership", { ...(await getRule("shopMembership")), ...input.membership }, actor) : await getRule("shopMembership");
  const subscription = input.subscription
    ? await setRule("shopRegistrationSubscription", { ...(await getRule("shopRegistrationSubscription")), ...input.subscription }, actor)
    : await getRule("shopRegistrationSubscription");
  return ok({ membership, subscription });
});
