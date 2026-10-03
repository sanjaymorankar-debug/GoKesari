/**
 * The signed-in user's own details: name, gender, mobile number and whether
 * the first-time details form has been completed. Email changes live in
 * otp/service.ts because they need a fresh code to the new address.
 */
import { and, count, eq, isNull } from "drizzle-orm";

import { notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { addresses, users, type UserRole } from "@/server/db/schema";
import { linkPhone, unlinkPhone } from "@/server/otp/service";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

export const GENDERS = ["MALE", "FEMALE", "OTHER"] as const;
export type Gender = (typeof GENDERS)[number];

export interface Profile {
  id: string;
  name: string | null;
  email: string;
  gender: Gender | null;
  phoneE164: string | null;
  profileCompletedAt: Date | null;
  addressCount: number;
  hasDefaultAddress: boolean;
}

export async function getProfile(userId: string): Promise<Profile> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw notFound("Account");
  const [{ total }] = await db
    .select({ total: count() })
    .from(addresses)
    .where(and(eq(addresses.userId, userId), isNull(addresses.deletedAt)));
  const [defaultAddress] = await db
    .select({ id: addresses.id })
    .from(addresses)
    .where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true), isNull(addresses.deletedAt)))
    .limit(1);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    gender: user.gender,
    phoneE164: user.phoneE164,
    profileCompletedAt: user.profileCompletedAt,
    addressCount: Number(total),
    hasDefaultAddress: Boolean(defaultAddress),
  };
}

export interface ProfileUpdate {
  name?: string | null;
  gender?: Gender | null;
  /** 10-digit Indian mobile; empty string or null removes it. Omit to leave unchanged. */
  mobile?: string | null;
  /** Marks the first-time details form as done, so it is not shown again. */
  markComplete?: boolean;
}

export async function updateProfile(userId: string, role: UserRole, input: ProfileUpdate): Promise<Profile> {
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name?.trim() ?? "";
    if (name.length > 100) throw validationFailed("Name can be at most 100 characters.");
    patch.name = name || null;
  }
  if (input.gender !== undefined) {
    if (input.gender !== null && !GENDERS.includes(input.gender)) throw validationFailed("Choose a gender from the list.");
    patch.gender = input.gender;
  }

  // The mobile number goes first: if it is taken, nothing else is saved and the form can be corrected.
  if (input.mobile !== undefined) {
    const mobile = input.mobile?.trim() ?? "";
    if (mobile) await linkPhone(userId, role, { mobile });
    else {
      const [current] = await db.select({ phoneE164: users.phoneE164 }).from(users).where(eq(users.id, userId));
      if (current?.phoneE164) await unlinkPhone(userId, role);
    }
  }

  if (input.markComplete) patch.profileCompletedAt = new Date();
  if (Object.keys(patch).length > 0) {
    const [before] = await db.select().from(users).where(eq(users.id, userId));
    if (!before) throw notFound("Account");
    if (before.profileCompletedAt && patch.profileCompletedAt) delete patch.profileCompletedAt;
    await db.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, userId));
    await recordAudit({
      actorId: userId,
      actorRole: role,
      action: AUDIT_ACTIONS.PROFILE_UPDATED,
      entityType: "user",
      entityId: userId,
      newValue: {
        fields: Object.keys(patch).filter((k) => k !== "profileCompletedAt"),
        ...(patch.profileCompletedAt ? { completed: true } : {}),
      },
    });
  }
  return getProfile(userId);
}

/** What a signed-in user should see right after signing in. */
export function nextOnboardingStep(profile: Pick<Profile, "profileCompletedAt" | "phoneE164">): "DETAILS" | "MOBILE" | "DONE" {
  if (!profile.profileCompletedAt) return "DETAILS";
  if (!profile.phoneE164) return "MOBILE";
  return "DONE";
}

