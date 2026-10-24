/**
 * Shared request-body schema for calendar dates (TC-FLD-108 / TC-FLD-109).
 *
 * Routes used to take `z.string()` and then call assertIsoDate(), whose
 * RangeError was not a validation error: "", "tomorrow" or "next friday"
 * answered 500, and "2026-02-31" passed the shape check and failed in
 * PostgreSQL. This schema accepts only a real calendar date written
 * YYYY-MM-DD, so anything else is a field-level 422 from route().
 */
import { z } from "zod";

import { isCalendarDate, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";

const NOT_A_DATE = "Enter a real date as YYYY-MM-DD.";

export const isoDateSchema = z.string().trim().refine(isCalendarDate, { message: NOT_A_DATE });

/** A real date that is today or later in the app's time zone (IST). */
export const todayOrLaterDateSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    if (!isCalendarDate(value)) ctx.addIssue({ code: "custom", message: NOT_A_DATE });
    else if (value < todayIn(getEnv().APP_TIMEZONE)) ctx.addIssue({ code: "custom", message: "The date cannot be in the past." });
  });
