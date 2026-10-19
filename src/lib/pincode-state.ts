/**
 * batch-2026-10 WS-E: the state of an Indian PIN code, for the place of supply
 * when a delivery address has no state recorded. India Post assigns the first
 * two (sometimes three) digits by postal circle; where a prefix spans two
 * states (e.g. 80–85 Bihar/Jharkhand, 24–26 UP/Uttarakhand) the answer is
 * null — "unknown" is better than a wrong state on a tax invoice. Codes are
 * the two-letter ones used across the app (MH, KA, TS, OD, UK…).
 */
const THREE_DIGIT: Record<string, string | null> = {
  "160": "CH",
  "194": "LA",
  "403": "GA",
  "396": null, // Gujarat / Dadra & Nagar Haveli and Daman & Diu
  "605": "PY",
  "607": null, // Tamil Nadu / Puducherry (Karaikal)
  "609": null,
  "737": "SK",
  "744": "AN",
  "682": null, // Kerala / Lakshadweep
  "790": "AR",
  "791": "AR",
  "792": "AR",
  "793": "ML",
  "794": "ML",
  "795": "MN",
  "796": "MZ",
  "797": "NL",
  "798": "NL",
  "799": "TR",
};

const TWO_DIGIT: Record<string, string> = {
  "11": "DL",
  "12": "HR",
  "13": "HR",
  "14": "PB",
  "15": "PB",
  "17": "HP",
  "18": "JK",
  "19": "JK",
  "20": "UP",
  "21": "UP",
  "22": "UP",
  "23": "UP",
  "27": "UP",
  "28": "UP",
  "30": "RJ",
  "31": "RJ",
  "32": "RJ",
  "33": "RJ",
  "34": "RJ",
  "36": "GJ",
  "37": "GJ",
  "38": "GJ",
  "39": "GJ",
  "40": "MH",
  "41": "MH",
  "42": "MH",
  "43": "MH",
  "44": "MH",
  "45": "MP",
  "46": "MP",
  "47": "MP",
  "48": "MP",
  "49": "CG",
  "50": "TS",
  "51": "AP",
  "52": "AP",
  "53": "AP",
  "56": "KA",
  "57": "KA",
  "58": "KA",
  "59": "KA",
  "60": "TN",
  "61": "TN",
  "62": "TN",
  "63": "TN",
  "64": "TN",
  "67": "KL",
  "68": "KL",
  "69": "KL",
  "70": "WB",
  "71": "WB",
  "72": "WB",
  "73": "WB",
  "74": "WB",
  "75": "OD",
  "76": "OD",
  "77": "OD",
  "78": "AS",
};

/** Two-letter state for a 6-digit PIN code, or null when unknown or ambiguous. */
export function stateForPincode(pincode: string | null | undefined): string | null {
  const pin = (pincode ?? "").replace(/\s+/g, "");
  if (!/^[1-9]\d{5}$/.test(pin)) return null;
  const three = pin.slice(0, 3);
  if (three in THREE_DIGIT) return THREE_DIGIT[three];
  return TWO_DIGIT[pin.slice(0, 2)] ?? null;
}
