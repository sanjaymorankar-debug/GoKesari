/**
 * GoKesari Health "Find a doctor": common symptoms a patient types → the doctor categories (consult
 * category slugs that need a medical council registration) that usually see them. A pointer for search
 * only — never advice. A symptom with no match falls back to a plain text search.
 */

export interface SymptomEntry {
  /** What the patient may type (lower case; the first is shown as the chip label). */
  words: readonly string[];
  /** Consult category slugs, best first. */
  specialties: readonly string[];
}

export const SYMPTOM_SPECIALTIES: readonly SymptomEntry[] = [
  { words: ["fever", "viral", "cold", "flu", "cough", "sore throat", "body ache", "weakness", "fatigue"], specialties: ["general-physician", "ent-specialist", "paediatrician"] },
  { words: ["headache", "migraine", "dizziness", "giddiness"], specialties: ["general-physician"] },
  { words: ["bp", "blood pressure", "diabetes", "sugar", "thyroid", "cholesterol"], specialties: ["general-physician"] },
  { words: ["stomach pain", "acidity", "gas", "vomiting", "diarrhoea", "diarrhea", "loose motion", "constipation"], specialties: ["general-physician", "paediatrician"] },
  { words: ["toothache", "tooth", "teeth", "gum", "cavity", "dental", "root canal"], specialties: ["dentist"] },
  { words: ["child", "baby", "infant", "vaccination", "vaccine", "newborn"], specialties: ["paediatrician"] },
  { words: ["pregnancy", "period", "periods", "menstrual", "pcos", "pcod", "white discharge", "infertility"], specialties: ["gynaecologist"] },
  { words: ["skin", "rash", "acne", "pimples", "itching", "hair fall", "dandruff", "allergy", "eczema", "fungal"], specialties: ["dermatologist"] },
  { words: ["back pain", "knee pain", "joint pain", "fracture", "sprain", "neck pain", "shoulder pain", "arthritis"], specialties: ["orthopaedic"] },
  { words: ["eye", "vision", "red eye", "eye pain", "spectacles", "cataract"], specialties: ["eye-specialist"] },
  { words: ["ear", "ear pain", "nose", "sinus", "tonsils", "throat", "hearing", "nosebleed"], specialties: ["ent-specialist"] },
  // Health specialties (owner, 21-Nov-2026; src/lib/health/specialties.ts): the specialists added in 0160.
  { words: ["heart", "chest pain", "palpitation", "palpitations", "heart attack", "angina"], specialties: ["cardiologist", "general-physician"] },
  { words: ["seizure", "fits", "epilepsy", "paralysis", "stroke", "numbness", "tremor", "memory loss", "migraine"], specialties: ["neurologist"] },
  { words: ["diabetes", "sugar", "thyroid", "hormone", "hormones"], specialties: ["diabetologist-endocrinologist"] },
  { words: ["liver", "jaundice", "fatty liver", "ulcer", "acidity", "stomach pain", "piles"], specialties: ["gastroenterologist"] },
  { words: ["asthma", "breathing", "breathlessness", "wheezing", "tb", "tuberculosis", "pneumonia", "chest infection"], specialties: ["pulmonologist", "general-physician"] },
  { words: ["kidney", "dialysis", "creatinine"], specialties: ["nephrologist", "urologist"] },
  { words: ["kidney stone", "stone", "urine", "burning urine", "urinary", "prostate"], specialties: ["urologist"] },
  { words: ["cancer", "tumour", "tumor", "lump", "chemotherapy"], specialties: ["oncologist"] },
  { words: ["hernia", "appendix", "gallstone", "gall bladder", "surgery", "operation", "piles"], specialties: ["general-surgeon"] },
  { words: ["braces", "crooked teeth", "aligners"], specialties: ["orthodontist", "dentist"] },
  { words: ["depression", "anxiety", "stress", "insomnia", "sleep", "panic", "addiction", "mental health"], specialties: ["psychiatrist", "psychologist-counsellor"] },
  { words: ["ayurveda", "ayurvedic", "homeopathy", "homeopathic", "panchakarma", "unani", "siddha", "naturopathy"], specialties: ["ayurveda-homeopathy", "unani", "siddha", "naturopathy"] },
];

/** Short labels for the symptom chips on the search screen. */
export const SYMPTOM_CHIPS: readonly string[] = ["Fever", "Cough", "Toothache", "Skin rash", "Back pain", "Child unwell", "Period problems", "Eye problem", "Ear pain", "Diabetes / BP", "Chest pain", "Stomach pain", "Kidney stone", "Anxiety / stress"];

/** Specialties for a typed symptom (best matches first), or [] when nothing matches. */
export function specialtiesForSymptom(raw: string | null | undefined): string[] {
  const text = (raw ?? "").toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const out: string[] = [];
  for (const entry of SYMPTOM_SPECIALTIES) {
    // "toothache since 2 days" contains "toothache"; a partly typed "dandr" is inside "dandruff".
    const hit = entry.words.some((w) => text === w || (` ${text} `.includes(` ${w} `) || (w.length > 3 && text.includes(w))) || (text.length >= 4 && w.startsWith(text)));
    if (hit) for (const s of entry.specialties) if (!out.includes(s)) out.push(s);
  }
  return out;
}
