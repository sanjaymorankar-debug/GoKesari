"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ImageUploader, type UploadedImage } from "@/components/image-uploader";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import {
  RETURN_CONDITIONS,
  RETURN_CONDITION_LABELS,
  RETURN_REASON_LABELS,
  returnQuantityStepError,
  type ReturnCondition,
  type ReturnReason,
} from "@/lib/return-states";
import { formatQuantity } from "@/lib/money";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";
import type { ReturnableOrder } from "@/server/services/returns";

interface Selection {
  selected: boolean;
  /** Quantity in the line's display unit (e.g. 2 for "2 packs"); converted to milli-units on submit. */
  quantity: string;
  condition: ReturnCondition;
  comment: string;
  images: UploadedImage[];
}

/** Wording (Module 6, docs/hindi-marathi-2026-11/). */
const T = {
  chooseReason: L("Choose a reason for the return.", "रिटर्न का कारण चुनें।", "परत करण्याचे कारण निवडा."),
  selectItem: L("Select at least one item to return.", "लौटाने के लिए कम से कम एक चीज़ चुनें।", "परत करण्यासाठी किमान एक वस्तू निवडा."),
  addPhoto: L("Please add a photo showing the problem.", "कृपया समस्या दिखाने वाली फ़ोटो जोड़ें।", "कृपया समस्या दाखवणारा फोटो जोडा."),
  badQty: L("Enter a quantity between 0 and {max} for {name}.", "{name} के लिए 0 से {max} के बीच मात्रा डालें।", "{name} साठी 0 ते {max} मधील प्रमाण टाका."),
  submitFailed: L("Could not submit the return.", "रिटर्न जमा नहीं हो सका।", "परताव्याची विनंती पाठवता आली नाही."),
  notReturnable: L("This order cannot be returned.", "यह ऑर्डर लौटाया नहीं जा सकता।", "ही ऑर्डर परत करता येत नाही."),
  until: L("You can request a return until {n}.", "आप {n} तक रिटर्न माँग सकते हैं।", "तुम्ही {n} पर्यंत परत करण्याची विनंती करू शकता."),
  inProgress: L(" — return already in progress", " — रिटर्न पहले से चल रहा है", " — परत करण्याची प्रक्रिया आधीच सुरू आहे"),
  qty: L("Quantity to return (max {n})", "लौटाने की मात्रा (अधिकतम {n})", "परत करायचे प्रमाण (कमाल {n})"),
  condition: L("Condition", "हालत", "स्थिती"),
  itemComment: L("Comment on this item (optional)", "इस चीज़ के बारे में टिप्पणी (वैकल्पिक)", "या वस्तूबद्दल टिप्पणी (ऐच्छिक)"),
  photos: L("Photos of this item", "इस चीज़ की फ़ोटो", "या वस्तूचे फोटो"),
  reason: L("Reason for the return", "रिटर्न का कारण", "परत करण्याचे कारण"),
  pickReason: L("Choose a reason…", "कारण चुनें…", "कारण निवडा…"),
  photoRequired: L("For this reason, at least one photo is required.", "इस कारण के लिए कम से कम एक फ़ोटो ज़रूरी है।", "या कारणासाठी किमान एक फोटो आवश्यक आहे."),
  anythingElse: L("Anything else the shop should know? (optional)", "दुकान को और कुछ बताना है? (वैकल्पिक)", "दुकानाला आणखी काही सांगायचे आहे? (ऐच्छिक)"),
  riderPickup: L(
    "If the return is approved, a rider will collect the goods from your delivery address.",
    "रिटर्न मंज़ूर होने पर राइडर आपके डिलीवरी पते से सामान ले जाएगा।",
    "परतावा मंजूर झाल्यावर रायडर तुमच्या डिलिव्हरी पत्त्यावरून माल घेऊन जाईल.",
  ),
  takeToShop: L(
    "If the return is approved, please take the goods to the shop.",
    "रिटर्न मंज़ूर होने पर कृपया सामान दुकान पर ले जाएँ।",
    "परतावा मंजूर झाल्यावर कृपया माल दुकानात घेऊन जा.",
  ),
  refundNote: L(
    "The refund goes to your wallet once the shop has checked the goods.",
    "दुकान के सामान जाँचने के बाद रिफंड आपके वॉलेट में आएगा।",
    "दुकानाने माल तपासल्यावर परतावा तुमच्या वॉलेटमध्ये जमा होईल.",
  ),
  submitting: L("Submitting…", "जमा हो रहा है…", "पाठवत आहे…"),
  submit: L("Submit return request", "रिटर्न अनुरोध भेजें", "परताव्याची विनंती पाठवा"),
} as const;

const REASON_TEXT: Record<ReturnReason, Text> = {
  DAMAGED: L("Damaged in delivery", "डिलीवरी में खराब हुआ", "डिलिव्हरीत खराब झाले"),
  WRONG_ITEM: L("Wrong item received", "गलत चीज़ मिली", "चुकीची वस्तू मिळाली"),
  QUALITY_ISSUE: L("Quality issue", "गुणवत्ता की समस्या", "गुणवत्तेची समस्या"),
  EXPIRED: L("Expired or near expiry", "एक्सपायर या एक्सपायरी के पास", "मुदत संपलेली किंवा संपत आलेली"),
  MISSING_ITEM: L("Item missing", "चीज़ गायब है", "वस्तू कमी आहे"),
  NOT_AS_DESCRIBED: L("Not as described", "बताए जैसा नहीं", "वर्णनानुसार नाही"),
  CHANGED_MIND: L("Changed my mind", "मेरा मन बदल गया", "माझा विचार बदलला"),
  OTHER: L("Something else", "कुछ और", "इतर काही"),
};

const CONDITION_TEXT: Record<ReturnCondition, Text> = {
  UNOPENED: L("Unopened / sealed", "बिना खुला / सील बंद", "न उघडलेले / सीलबंद"),
  OPENED: L("Opened", "खुला हुआ", "उघडलेले"),
  DAMAGED: L("Damaged", "खराब", "खराब"),
  EXPIRED: L("Expired", "एक्सपायर", "मुदत संपलेले"),
  USED: L("Used", "इस्तेमाल किया हुआ", "वापरलेले"),
};

/** Order → choose items and quantities → reason, condition, photos, comments → submit. */
export function ReturnRequestForm({ order, lang = "en" }: { order: ReturnableOrder; lang?: Lang }) {
  const router = useRouter();
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, Selection>>(() =>
    Object.fromEntries(
      order.lines.map((l) => [
        l.orderItemId,
        { selected: false, quantity: String(l.availableMilli / 1000), condition: "UNOPENED" as ReturnCondition, comment: "", images: [] },
      ]),
    ),
  );

  const policy = order.reasons.find((r) => r.reason === reason);
  const chosen = order.lines.filter((l) => selection[l.orderItemId]?.selected);
  const imageCount = new Set(chosen.flatMap((l) => selection[l.orderItemId].images.map((i) => i.id))).size;

  function patch(id: string, change: Partial<Selection>) {
    setSelection((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }));
  }

  async function submit() {
    setError(null);
    if (!reason) return setError(tr(T.chooseReason, lang));
    if (chosen.length === 0) return setError(tr(T.selectItem, lang));
    if (policy?.requiresImages && imageCount === 0) return setError(tr(T.addPhoto, lang));

    const items = [];
    for (const line of chosen) {
      const sel = selection[line.orderItemId];
      const milli = Math.round(Number(sel.quantity) * 1000);
      if (!Number.isFinite(milli) || milli <= 0 || milli > line.availableMilli) {
        return setError(tr(T.badQty, lang).replace("{max}", String(line.availableMilli / 1000)).replace("{name}", line.name));
      }
      // TC-RET-003: whole pieces for a per-piece line, as the server checks.
      const stepError = milli === line.availableMilli ? null : returnQuantityStepError(line.unit, milli, line.name);
      if (stepError) return setError(stepError);
      items.push({
        orderItemId: line.orderItemId,
        quantityMilli: milli,
        condition: sel.condition,
        comment: sel.comment || null,
        imageIds: sel.images.map((i) => i.id),
      });
    }

    setBusy(true);
    const res = await fetch(`/api/orders/${order.orderId}/returns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, comment: comment || null, items }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(payload?.error?.message ? errorText(payload.error.message, lang, payload.error.code) : tr(T.submitFailed, lang));
      return;
    }
    router.push(`/returns/${payload.id}`);
    router.refresh();
  }

  if (!order.eligible) {
    return <Alert tone="warning">{order.reason ? errorText(order.reason, lang) : tr(T.notReturnable, lang)}</Alert>;
  }

  return (
    <div className="space-y-5" data-testid="return-form">
      {order.windowEndsAt ? (
        <p className="text-sm text-ink-500">
          {tr(T.until, lang).replace("{n}", new Date(order.windowEndsAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }))}
        </p>
      ) : null}

      <Card className="divide-y divide-cream-200">
        {order.lines.map((line) => {
          const sel = selection[line.orderItemId];
          const disabled = line.availableMilli === 0;
          return (
            <div key={line.orderItemId} className="space-y-3 p-4">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={disabled}
                  checked={sel.selected}
                  onChange={(e) => patch(line.orderItemId, { selected: e.target.checked })}
                />
                <span className="text-sm">
                  <span className="font-medium text-ink-900">{line.name}</span>{" "}
                  <span className="text-ink-500">
                    · {formatQuantity(line.totalMilli, line.unit)}
                    {disabled ? tr(T.inProgress, lang) : ""}
                  </span>
                </span>
              </label>
              {sel.selected ? (
                <div className="grid gap-3 pl-7 sm:grid-cols-2">
                  <Field label={tr(T.qty, lang).replace("{n}", String(line.availableMilli / 1000))}>
                    <input
                      className={inputClass}
                      inputMode="decimal"
                      value={sel.quantity}
                      onChange={(e) => patch(line.orderItemId, { quantity: e.target.value })}
                    />
                  </Field>
                  <Field label={tr(T.condition, lang)}>
                    <select
                      className={inputClass}
                      value={sel.condition}
                      onChange={(e) => patch(line.orderItemId, { condition: e.target.value as ReturnCondition })}
                    >
                      {RETURN_CONDITIONS.map((c) => (
                        <option key={c} value={c}>
                          {lang === "en" ? RETURN_CONDITION_LABELS[c] : tr(CONDITION_TEXT[c], lang)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label={tr(T.itemComment, lang)}>
                      <input
                        className={inputClass}
                        value={sel.comment}
                        maxLength={500}
                        onChange={(e) => patch(line.orderItemId, { comment: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="sm:col-span-2">
                    <p className="mb-1 text-sm font-medium text-ink-700">{tr(T.photos, lang)}</p>
                    <ImageUploader
                      purpose="RETURN_EVIDENCE"
                      value={sel.images}
                      max={order.maxImages}
                      onChange={(images) => patch(line.orderItemId, { images })}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </Card>

      <Field label={tr(T.reason, lang)}>
        <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value as ReturnReason)}>
          <option value="">{tr(T.pickReason, lang)}</option>
          {order.reasons.map((r) => (
            <option key={r.reason} value={r.reason}>
              {lang === "en" ? RETURN_REASON_LABELS[r.reason] : tr(REASON_TEXT[r.reason], lang)}
            </option>
          ))}
        </select>
      </Field>
      {policy?.requiresImages ? (
        <p className="text-xs text-ink-500">{tr(T.photoRequired, lang)}</p>
      ) : null}

      <Field label={tr(T.anythingElse, lang)}>
        <textarea className={inputClass} rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>

      <p className="text-xs text-ink-500">
        {tr(order.pickupByRider ? T.riderPickup : T.takeToShop, lang)}{" "}
        {tr(T.refundNote, lang)}
      </p>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button disabled={busy} onClick={submit}>
        {tr(busy ? T.submitting : T.submit, lang)}
      </Button>
    </div>
  );
}
