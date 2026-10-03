"use client";

/**
 * Screen 3 — an admin edits another account's profile, with an explicit Save.
 *
 * Editable: display name, contact phone, and account status. Read-only, and
 * shown so the admin can see them without being able to forge them: the email
 * (the OAuth identity and unique login key) and the verified login mobile
 * (`phoneE164` / `phoneVerifiedAt` — possession is proven by SMS, never by an
 * admin typing it). Role lives on the privileges screen.
 *
 * A status change needs a reason, because the server routes it through
 * suspendUser()/reinstateUser(), which record one.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { SaveChangesBar, postJson, useSaveChanges } from "@/components/save-changes-bar";
import { Alert, Badge, Card, Field, inputClass } from "@/components/ui";

type AccountStatus = "ACTIVE" | "SUSPENDED";

interface ProfileDraft {
  name: string;
  phone: string;
  status: AccountStatus;
  statusReason: string;
}

export function UserProfileAdminForm({
  userId,
  email,
  loginMobile,
  roleLabel,
  isSelf,
  initial,
}: {
  userId: string;
  email: string;
  loginMobile: string | null;
  roleLabel: string;
  isSelf: boolean;
  initial: { name: string | null; phone: string | null; status: AccountStatus };
}) {
  const router = useRouter();
  const blank: ProfileDraft = {
    name: initial.name ?? "",
    phone: initial.phone ?? "",
    status: initial.status,
    statusReason: "",
  };
  const [baseline, setBaseline] = useState(blank);
  const [draft, setDraft] = useState(blank);

  const statusChanged = draft.status !== baseline.status;
  const dirty = draft.name !== baseline.name || draft.phone !== baseline.phone || statusChanged;

  const displayName = baseline.name || email;

  const clientError = (() => {
    const name = draft.name.trim();
    if (name && (name.length < 2 || name.length > 120)) return "A name needs 2–120 characters.";
    const phone = draft.phone.replace(/[\s-]/g, "");
    if (phone && !/^\+?\d{6,15}$/.test(phone)) return "Enter a valid contact number, digits only.";
    if (statusChanged && draft.statusReason.trim().length < 3) {
      return "Give a reason for the account status change (at least 3 characters).";
    }
    return null;
  })();

  const save = useSaveChanges({
    id: `profile:${userId}`,
    dirty: dirty && !clientError,
    // Suspending an account signs the person out, so that one is confirmed.
    confirm: () =>
      statusChanged
        ? {
            title: draft.status === "SUSPENDED" ? `Suspend ${displayName}?` : `Reinstate ${displayName}?`,
            lines: [
              `Account status: ${baseline.status} → ${draft.status}`,
              `Reason: ${draft.statusReason.trim()}`,
            ],
            body:
              draft.status === "SUSPENDED"
                ? "A suspended account cannot sign in, and any current session stops working on its next request."
                : "The account can sign in again. A rider profile suspended with it stays suspended until reactivated separately.",
            confirmLabel: draft.status === "SUSPENDED" ? "Yes, suspend" : "Yes, reinstate",
          }
        : null,
    onSave: async () => {
      const result = await postJson<{ changedFields: string[]; status: AccountStatus }>(
        `/api/users/${userId}`,
        "PATCH",
        {
          name: draft.name.trim() || null,
          phone: draft.phone.replace(/[\s-]/g, "") || null,
          ...(statusChanged ? { status: draft.status, statusReason: draft.statusReason.trim() } : {}),
        },
      );
      const settled: ProfileDraft = { ...draft, status: result.status, statusReason: "" };
      setBaseline(settled);
      setDraft(settled);
      router.refresh();
      const what = result.changedFields.length > 0 ? result.changedFields.join(", ") : "no fields";
      return `Profile updated for ${draft.name.trim() || email}: ${what}`;
    },
  });

  return (
    <div className="space-y-4" data-testid="user-profile-admin-form">
      <Card className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" hint="Shown to the account holder and in operations screens.">
            <input
              className={inputClass}
              value={draft.name}
              maxLength={120}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </Field>
          <Field label="Contact phone" hint="For operations to reach this person. Does not affect sign-in.">
            <input
              className={inputClass}
              value={draft.phone}
              maxLength={20}
              inputMode="tel"
              onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
            />
          </Field>
        </div>

        <dl className="grid gap-2 rounded-lg bg-cream-50 p-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-ink-500">Email (sign-in identity)</dt>
            <dd className="text-ink-700">{email}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-ink-500">Verified login mobile</dt>
            <dd className="text-ink-700">{loginMobile ?? "Not linked"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-ink-500">Acting as</dt>
            <dd className="text-ink-700">{roleLabel}</dd>
          </div>
        </dl>
        <p className="text-xs text-ink-500">
          Email and the verified login mobile cannot be changed here: they are how this person signs in, and the mobile
          counts as verified only once possession was proven by SMS.
        </p>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-ink-900">Account status</h2>
          <Badge tone={baseline.status === "ACTIVE" ? "success" : "danger"}>{baseline.status.toLowerCase()}</Badge>
        </div>
        {isSelf ? (
          <Alert tone="warning">You cannot suspend your own account.</Alert>
        ) : (
          <>
            <div className="flex flex-wrap gap-4">
              {(["ACTIVE", "SUSPENDED"] as const).map((status) => (
                <label key={status} className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="radio"
                    name="status"
                    value={status}
                    checked={draft.status === status}
                    onChange={() => setDraft((d) => ({ ...d, status }))}
                  />
                  {status === "ACTIVE" ? "Active" : "Suspended"}
                </label>
              ))}
            </div>
            {statusChanged ? (
              <Field label="Reason" hint="Recorded in the audit log and shown in the account-status notification.">
                <input
                  className={inputClass}
                  value={draft.statusReason}
                  maxLength={500}
                  onChange={(e) => setDraft((d) => ({ ...d, statusReason: e.target.value }))}
                />
              </Field>
            ) : null}
            <p className="text-xs text-ink-500">
              An admin account cannot be suspended — remove its admin right on the privileges screen first.
            </p>
          </>
        )}
      </Card>

      {clientError ? <Alert tone="danger">{clientError}</Alert> : null}

      <SaveChangesBar
        state={save}
        label="Save Changes"
        dirtyHint="Unsaved profile changes — nothing is written yet."
        testId="profile-save"
      />
    </div>
  );
}
