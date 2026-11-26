"use client";

/**
 * Rider App v2: "Why are you turning this down?" — Too far / Vehicle issue /
 * Ending shift (one tap sends) or Other (with an optional note, then confirm).
 * Used by the single offer card (G1) and Available Deliveries' Reject.
 */
import { useState } from "react";

import { Button } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";
import { RIDER_REJECT_REASONS, RIDER_REJECT_REASON_LABEL, type RiderRejectReason } from "@/lib/rider-reject-reasons";

const T = {
  why: L("Why are you turning this down?", "आप इसे क्यों मना कर रहे हैं?", "तुम्ही हे का नाकारत आहात?"),
  note: L("Tell us more (optional)", "थोड़ा और बताएँ (वैकल्पिक)", "थोडे अधिक सांगा (ऐच्छिक)"),
  confirm: L("Reject", "मना करें", "नाकारा"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
} as const;

export function RejectReasonPicker({
  lang,
  busy = false,
  onPick,
  onCancel,
}: {
  lang: Lang;
  busy?: boolean;
  onPick: (reason: RiderRejectReason, note: string) => void;
  onCancel: () => void;
}) {
  const [other, setOther] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="w-full space-y-2 rounded-lg border border-cream-200 bg-cream-50 p-3" data-testid="reject-reason-picker">
      <p className="text-sm font-medium text-ink-800">{tr(T.why, lang)}</p>
      <div className="grid grid-cols-2 gap-2">
        {RIDER_REJECT_REASONS.map((code) => (
          <Button
            key={code}
            size="sm"
            variant={other && code === "OTHER" ? "primary" : "secondary"}
            disabled={busy}
            aria-pressed={other && code === "OTHER"}
            onClick={() => (code === "OTHER" ? setOther(true) : onPick(code, ""))}
            data-testid={`reject-reason-${code.toLowerCase()}`}
          >
            {tr(RIDER_REJECT_REASON_LABEL[code], lang)}
          </Button>
        ))}
      </div>
      {other ? (
        <div className="space-y-2">
          <input
            className="w-full rounded-lg border border-cream-200 px-3 py-2 text-sm"
            maxLength={300}
            placeholder={tr(T.note, lang)}
            aria-label={tr(T.note, lang)}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button size="sm" variant="danger" disabled={busy} onClick={() => onPick("OTHER", note.trim())}>
            {tr(T.confirm, lang)}
          </Button>
        </div>
      ) : null}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        {tr(T.cancel, lang)}
      </Button>
    </div>
  );
}
