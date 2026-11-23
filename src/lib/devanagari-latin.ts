/**
 * Devanagari → rough Latin letters, for matching only (docs/smart-shopping-2026-11, FEATURE4): a Hindi or
 * Marathi recogniser writes brand names in Devanagari ("अमूल बटर", "पारले जी", "मॅगी") while the catalogue
 * has them in English ("Amul Butter", "Parle G", "Maggi"). The result feeds a fuzzy (pg_trgm) match, so it
 * favours short, plain spellings over a faithful transliteration. Client-safe.
 */

const VOWELS: Record<string, string> = {
  "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ॲ": "a",
};
const MATRAS: Record<string, string> = {
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e",
};
const CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "f", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "ळ": "l", "व": "v",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
};
const NUKTA_FORMS: Record<string, string> = { "ड": "r", "ढ": "rh", "ज": "z", "फ": "f", "क": "q", "ख": "kh", "ग": "g" };
const VIRAMA = "्";
const NUKTA = "़";

export function hasDevanagari(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

/** "अमूल बटर" → "amul batar", "पारले जी" → "parle ji", "मॅगी" → "megi". Other characters pass through. */
export function devanagariToLatin(text: string): string {
  const chars = [...text.normalize("NFC")];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (VOWELS[c] !== undefined) {
      out += VOWELS[c];
      continue;
    }
    if (CONSONANTS[c] !== undefined) {
      let latin = CONSONANTS[c];
      let j = i + 1;
      if (chars[j] === NUKTA) {
        latin = NUKTA_FORMS[c] ?? latin;
        j++;
      }
      out += latin;
      const next = chars[j];
      if (next !== undefined && MATRAS[next] !== undefined) {
        out += MATRAS[next];
        j++;
      } else if (next === VIRAMA) {
        j++;
      } else {
        // The inherent "a", dropped at the end of a word ("बटर" → "batar", not "batara").
        const endOfWord = next === undefined || !/[ऀ-ॿ]/.test(next) || next === " ";
        if (!endOfWord) out += "a";
      }
      i = j - 1;
      continue;
    }
    if (c === "ं" || c === "ँ") {
      out += "n";
      continue;
    }
    if (c === "ः") {
      out += "h";
      continue;
    }
    if (MATRAS[c] !== undefined || c === VIRAMA || c === NUKTA) continue;
    out += c;
  }
  return out.replace(/\s+/g, " ").trim();
}
