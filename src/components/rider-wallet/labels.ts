import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

/** Rider transfer statuses in plain words (docs/gig-bank-payouts-2026-10). */
export const TRANSFER_STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  PENDING: { label: "Pending", tone: "info" },
  PROCESSING: { label: "On its way", tone: "info" },
  SUCCESS: { label: "Paid", tone: "success" },
  FAILED: { label: "Failed — retrying", tone: "warning" },
  REVERSED: { label: "Returned by bank", tone: "danger" },
  RELEASED: { label: "Failed — back in balance", tone: "danger" },
};

export const KIND_LABEL = { WITHDRAWAL: "Withdrawal", MONTHLY: "Monthly payout" } as const;

/* Module 6: the rider's own wallet screens in Hindi and Marathi (admin pages keep the English above). */

const TRANSFER_STATUS_TEXT: Record<string, Text> = {
  PENDING: L("Pending", "बाकी", "प्रलंबित"),
  PROCESSING: L("On its way", "रास्ते में", "वाटेत"),
  SUCCESS: L("Paid", "भुगतान हुआ", "पैसे दिले"),
  FAILED: L("Failed — retrying", "असफल — फिर कोशिश हो रही है", "अयशस्वी — पुन्हा प्रयत्न सुरू"),
  REVERSED: L("Returned by bank", "बैंक ने लौटाया", "बँकेने परत केले"),
  RELEASED: L("Failed — back in balance", "असफल — बैलेंस में वापस", "अयशस्वी — शिलकीत परत"),
};

const KIND_TEXT: Record<string, Text> = {
  WITHDRAWAL: L("Withdrawal", "निकासी", "रक्कम काढणे"),
  MONTHLY: L("Monthly payout", "मासिक पेआउट", "मासिक पेआउट"),
};

/** A transfer status in the rider's language; English is exactly TRANSFER_STATUS[status].label. */
export function transferStatusText(status: string, lang: Lang): string {
  const english = TRANSFER_STATUS[status]?.label ?? status;
  const text = TRANSFER_STATUS_TEXT[status];
  return lang === "en" || !text ? english : tr(text, lang);
}

/** A transfer kind in the rider's language; English is exactly KIND_LABEL[kind]. */
export function kindText(kind: string, lang: Lang): string {
  const english = (KIND_LABEL as Record<string, string>)[kind] ?? kind;
  const text = KIND_TEXT[kind];
  return lang === "en" || !text ? english : tr(text, lang);
}
