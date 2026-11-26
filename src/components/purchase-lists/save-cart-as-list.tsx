"use client";

import Link from "next/link";
import { useState } from "react";

import { Choice } from "@/components/purchase-lists/create-list-form";
import { Button, Card, Field, inputClass } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";
import { KIND_EMOJI, LIST_LIMITS, type ListFrequency, type ListKind } from "@/lib/purchase-lists";

/** docs/hindi-marathi-2026-11 (staging E2E 25-Nov-2026): the card's words in three languages. */
const T = {
  saveAsList: L("Save as a list", "सूची के रूप में सहेजें", "यादी म्हणून जतन करा"),
  hint: L(
    "Buy these every week or month? Save them and reorder in a few taps.",
    "ये हर हफ़्ते या महीने ख़रीदते हैं? सहेजें और कुछ टैप में दोबारा ऑर्डर करें।",
    "हे दर आठवड्याला किंवा महिन्याला घेता? जतन करा आणि काही टॅपमध्ये पुन्हा ऑर्डर करा.",
  ),
  savedTo: L("Saved to", "यहाँ सहेजा गया:", "येथे जतन केले:"),
  openList: L("Open the list", "सूची खोलें", "यादी उघडा"),
  saveTo: L("Save to", "कहाँ सहेजें", "कुठे जतन करायचे"),
  newList: L("A new list", "नई सूची", "नवीन यादी"),
  whatFor: L("What is it for?", "यह किसके लिए है?", "हे कशासाठी आहे?"),
  listName: L("List name", "सूची का नाम", "यादीचे नाव"),
  medsPlaceholder: L("Monthly medicines", "हर महीने की दवाइयाँ", "दरमहाची औषधे"),
  groceryPlaceholder: L("Monthly groceries", "हर महीने का राशन", "दरमहाचा किराणा"),
  howOften: L("How often?", "कितनी बार?", "किती वेळा?"),
  sameQty: L(
    "Products already on that list take the quantity in your cart.",
    "उस सूची में पहले से मौजूद सामान की मात्रा आपके कार्ट जितनी हो जाएगी।",
    "त्या यादीत आधीपासून असलेल्या वस्तूंचे प्रमाण तुमच्या कार्टइतके होईल.",
  ),
  saving: L("Saving…", "सहेज रहे हैं…", "जतन करत आहोत…"),
  saveList: L("Save list", "सूची सहेजें", "यादी जतन करा"),
  failed: L("Could not save the list.", "सूची सहेजी नहीं जा सकी।", "यादी जतन करता आली नाही."),
  offline: L("Could not save the list. Check your connection.", "सूची सहेजी नहीं जा सकी। अपना कनेक्शन जाँचें।", "यादी जतन करता आली नाही. तुमचे कनेक्शन तपासा."),
};
const KIND_TEXT = {
  SHOPPING: L("Shopping list", "ख़रीदारी की सूची", "खरेदीची यादी"),
  MEDICINE: L("Medicines", "दवाइयाँ", "औषधे"),
} as const;
const FREQUENCY_TEXT = {
  WEEKLY: L("Weekly", "हर हफ़्ते", "दर आठवड्याला"),
  MONTHLY: L("Monthly", "हर महीने", "दरमहा"),
} as const;

/**
 * "Save as a list" on the cart (docs/purchase-lists-2026-10): what is in the
 * cart becomes a weekly / monthly list — a new one, or one the customer
 * already has (a product already on it takes the cart's quantity).
 */
export function SaveCartAsList({ lists: initialLists, lang = "en" }: { lists: { id: string; name: string; kind: ListKind }[]; lang?: Lang }) {
  const [lists, setLists] = useState(initialLists);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string>("new");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ListKind>("SHOPPING");
  const [frequency, setFrequency] = useState<ListFrequency>("MONTHLY");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/purchase-lists/from-cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target === "new" ? { name, kind, frequency } : { listId: target }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? tr(T.failed, lang));
        return;
      }
      setSaved({ id: payload.id, name: payload.name });
      // A list just created is offered next time without a reload.
      if (!lists.some((l) => l.id === payload.id)) setLists((current) => [...current, { id: payload.id, name: payload.name, kind: payload.kind }]);
      setTarget(payload.id);
      setOpen(false);
    } catch {
      setError(tr(T.offline, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4" data-testid="save-cart-as-list">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span aria-hidden>📝</span> {tr(T.saveAsList, lang)}
        </Button>
        <span className="text-xs text-ink-500">{tr(T.hint, lang)}</span>
      </div>
      {saved ? (
        <p className="mt-2 text-sm text-leaf-700" role="status">
          {tr(T.savedTo, lang)} &quot;{saved.name}&quot;.{" "}
          <Link href={`/lists/${saved.id}`} className="font-medium underline">
            {tr(T.openList, lang)}
          </Link>
        </p>
      ) : null}
      {open ? (
        <Card className="mt-2 p-4">
          <form onSubmit={save} className="space-y-4">
            {lists.length > 0 ? (
              <Field label={tr(T.saveTo, lang)}>
                <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)} name="save-target">
                  <option value="new">{tr(T.newList, lang)}</option>
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {KIND_EMOJI[list.kind]} {list.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {target === "new" ? (
              <>
                <Choice
                  label={tr(T.whatFor, lang)}
                  name="save-kind"
                  value={kind}
                  onChange={setKind}
                  options={(["SHOPPING", "MEDICINE"] as const).map((k) => ({ value: k, label: `${KIND_EMOJI[k]} ${tr(KIND_TEXT[k], lang)}` }))}
                />
                <Field label={tr(T.listName, lang)}>
                  <input
                    className={inputClass}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={LIST_LIMITS.nameLength}
                    placeholder={tr(kind === "MEDICINE" ? T.medsPlaceholder : T.groceryPlaceholder, lang)}
                    required
                    name="save-name"
                  />
                </Field>
                <Choice
                  label={tr(T.howOften, lang)}
                  name="save-frequency"
                  value={frequency}
                  onChange={setFrequency}
                  options={(["WEEKLY", "MONTHLY"] as const).map((f) => ({ value: f, label: tr(FREQUENCY_TEXT[f], lang) }))}
                />
              </>
            ) : (
              <p className="text-xs text-ink-500">{tr(T.sameQty, lang)}</p>
            )}
            {error ? (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={busy || (target === "new" && !name.trim())}>
              {tr(busy ? T.saving : T.saveList, lang)}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
