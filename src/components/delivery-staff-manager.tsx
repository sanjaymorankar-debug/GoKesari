"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Field, inputClass } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6: Hindi / Marathi (English unchanged). */
const T = {
  addTitle: L("Add a delivery person", "डिलीवरी करने वाला व्यक्ति जोड़ें", "डिलिव्हरी करणारी व्यक्ती जोडा"),
  addFailed: L("Could not add them.", "जोड़ा नहीं जा सका।", "जोडता आले नाही."),
  added: L("{name} added.", "{name} जुड़ गए।", "{name} जोडले."),
  name: L("Name", "नाम", "नाव"),
  mobile: L("Mobile number", "मोबाइल नंबर", "मोबाइल नंबर"),
  mobilePh: L("10-digit mobile", "10 अंकों का मोबाइल", "10 अंकी मोबाइल"),
  add: L("Add", "जोड़ें", "जोडा"),
  none: L("No delivery people yet", "अभी कोई डिलीवरी करने वाला नहीं", "अजून डिलिव्हरी करणारे कोणी नाही"),
  noneText: L(
    "Add the people who deliver for your shop. You choose one when you mark an order ready for your own delivery.",
    "अपनी दुकान के लिए डिलीवरी करने वालों को जोड़ें। अपनी डिलीवरी के लिए ऑर्डर तैयार मार्क करते समय आप उनमें से एक चुनेंगे।",
    "तुमच्या दुकानासाठी डिलिव्हरी करणाऱ्यांना जोडा. स्वतःच्या डिलिव्हरीसाठी ऑर्डर तयार म्हणून नोंदवताना तुम्ही त्यांच्यापैकी एक निवडाल.",
  ),
  saveFailed: L("Could not save.", "सहेजा नहीं जा सका।", "जतन करता आले नाही."),
  save: L("Save", "सहेजें", "जतन करा"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
  deactivated: L("deactivated", "निष्क्रिय", "निष्क्रिय"),
  edit: L("Edit", "बदलें", "बदला"),
  deactivate: L("Deactivate", "निष्क्रिय करें", "निष्क्रिय करा"),
  reactivate: L("Reactivate", "फिर से सक्रिय करें", "पुन्हा सक्रिय करा"),
} as const;

export interface DeliveryStaffRow {
  id: string;
  name: string;
  phoneE164: string;
  isActive: boolean;
}

/**
 * The shop's own delivery people (docs/four-features-2026-10, feature 1):
 * add, edit, deactivate / reactivate. Only name and mobile are kept.
 */
export function DeliveryStaffManager({ shopId, staff, lang = "en" }: { shopId: string; staff: DeliveryStaffRow[]; /** Module 6: board language. */ lang?: Lang }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function send(url: string, method: string, body: unknown, fallback: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(payload?.error?.message ?? fallback, lang, payload?.error?.code));
      router.refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink-900">{tr(T.addTitle, lang)}</h2>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await send(`/api/shops/${shopId}/delivery-staff`, "POST", { name, mobile }, tr(T.addFailed, lang))) {
              setNotice(tr(T.added, lang).replace("{name}", name.trim()));
              setName("");
              setMobile("");
            }
          }}
        >
          <Field label={tr(T.name, lang)}>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} />
          </Field>
          <Field label={tr(T.mobile, lang)}>
            <input
              className={inputClass}
              value={mobile}
              onChange={(e) => setMobile(e.target.value.replace(/[^\d]/g, "").slice(0, 10))}
              inputMode="numeric"
              placeholder={tr(T.mobilePh, lang)}
              required
            />
          </Field>
          <Button type="submit" disabled={busy || name.trim().length < 2 || mobile.length !== 10}>
            {tr(T.add, lang)}
          </Button>
        </form>
        {error ? (
          <div className="mt-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
        {notice ? <p className="mt-2 text-sm text-leaf-700">{notice}</p> : null}
      </Card>

      {staff.length === 0 ? (
        <EmptyState title={tr(T.none, lang)} description={tr(T.noneText, lang)} />
      ) : (
        <Card className="divide-y divide-cream-100">
          {staff.map((member) => (
            <StaffRow key={member.id} member={member} busy={busy} lang={lang} onSave={(patch) => send(`/api/shops/${shopId}/delivery-staff/${member.id}`, "PATCH", patch, tr(T.saveFailed, lang))} />
          ))}
        </Card>
      )}
    </div>
  );
}

function StaffRow({
  member,
  busy,
  lang,
  onSave,
}: {
  member: DeliveryStaffRow;
  busy: boolean;
  lang: Lang;
  onSave: (patch: { name?: string; mobile?: string; isActive?: boolean }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [mobile, setMobile] = useState(member.phoneE164.replace(/^\+91/, ""));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="delivery-staff-row">
      {editing ? (
        <form
          className="grid w-full gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onSave({ name, mobile })) setEditing(false);
          }}
        >
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} aria-label={tr(T.name, lang)} />
          <input
            className={inputClass}
            value={mobile}
            onChange={(e) => setMobile(e.target.value.replace(/[^\d]/g, "").slice(0, 10))}
            inputMode="numeric"
            aria-label={tr(T.mobile, lang)}
          />
          <Button size="sm" type="submit" disabled={busy}>
            {tr(T.save, lang)}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
            {tr(T.cancel, lang)}
          </Button>
        </form>
      ) : (
        <>
          <div>
            <p className="font-medium text-ink-900">
              {member.name} {member.isActive ? null : <Badge tone="warning">{tr(T.deactivated, lang)}</Badge>}
            </p>
            <p className="text-sm text-ink-500">{member.phoneE164.replace(/^\+91/, "+91 ")}</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
              {tr(T.edit, lang)}
            </Button>
            <Button
              size="sm"
              variant={member.isActive ? "ghost" : "secondary"}
              disabled={busy}
              onClick={() => void onSave({ isActive: !member.isActive })}
            >
              {member.isActive ? tr(T.deactivate, lang) : tr(T.reactivate, lang)}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
