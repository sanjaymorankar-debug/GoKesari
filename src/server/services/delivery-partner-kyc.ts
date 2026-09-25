/**
 * Delivery-partner KYC and bank details — encrypted at rest (SEC-02,
 * docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md).
 *
 * These six fields used to be stored as plain `text` and were returned, in
 * full, by every API route that serialises a `delivery_partners` row (the
 * admin list, the detail view, the partner's own profile, every status
 * transition). Now:
 *
 *   - registration stores AES-256-GCM ciphertext only (same key and format as
 *     the shop PAN — see src/lib/pan-crypto.ts);
 *   - nothing sensitive, plaintext or ciphertext, leaves the service layer:
 *     `toPublicPartner` is applied to every row the partner service returns;
 *   - `backfillDeliveryPartnerKyc` migrates rows written before this change.
 *
 * There is deliberately no "reveal" path yet: nothing in the app reads these
 * values today (the review queue never displayed them). When a KYC-review UI
 * or a payout job needs one, add an ADMIN-only, audited reveal modelled on
 * `revealPanForAdmin` in gst-pan-verification.ts rather than reading the
 * columns directly.
 */
import { and, eq, isNotNull, or } from "drizzle-orm";

import { isPanEncryptionConfigured } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { decryptSecret, encryptSecret } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { deliveryPartners, type DeliveryPartner } from "@/server/db/schema";

export const KYC_FIELDS = [
  "panNumber",
  "governmentIdNumber",
  "bankAccountHolderName",
  "bankAccountNumber",
  "bankIfsc",
  "drivingLicenceNumber",
] as const;

export type KycField = (typeof KYC_FIELDS)[number];
export type KycEncryptedKey = `${KycField}Encrypted`;

const encryptedKey = (field: KycField): KycEncryptedKey => `${field}Encrypted`;

/** Every column that must never leave the service layer: legacy plaintext and ciphertext alike. */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set<string>([
  ...KYC_FIELDS,
  ...KYC_FIELDS.map(encryptedKey),
]);

export type PublicDeliveryPartner = Omit<DeliveryPartner, KycField | KycEncryptedKey>;

/**
 * The only shape of a partner row that may be returned to a caller. Applied
 * to legacy plaintext columns too, so a row not yet backfilled cannot leak.
 */
export function toPublicPartner(row: DeliveryPartner): PublicDeliveryPartner {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !SENSITIVE_KEYS.has(key)),
  ) as PublicDeliveryPartner;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Encrypts whichever of the six fields were supplied, ready to spread into
 * an insert. Blank values become "not provided". Refuses — rather than
 * falling back to plaintext — when a value was supplied but no key is
 * configured; registration without any of these fields is unaffected.
 */
export function encryptKycInput(
  input: Partial<Record<KycField, string | null | undefined>>,
): Partial<Record<KycEncryptedKey, string>> {
  const provided = KYC_FIELDS.filter((field) => clean(input[field]) !== null);
  if (provided.length === 0) return {};

  if (!isPanEncryptionConfigured()) {
    console.error(
      "[kyc] PAN_ENCRYPTION_KEY is not configured — refusing to store delivery-partner KYC/bank details.",
    );
    throw new AppError(
      "INTERNAL",
      "We can't securely store identity or bank details right now. Please leave those fields blank and try again, or contact support.",
    );
  }

  const encrypted: Partial<Record<KycEncryptedKey, string>> = {};
  for (const field of provided) {
    encrypted[encryptedKey(field)] = encryptSecret(clean(input[field])!);
  }
  return encrypted;
}

export interface KycBackfillOptions {
  /** Write ciphertext. Without it the run only reports what it would do. */
  apply?: boolean;
  /**
   * Also NULL each legacy plaintext column — but only after re-reading the
   * stored ciphertext and confirming it decrypts to exactly that plaintext.
   * Implies `apply`.
   */
  nullPlaintext?: boolean;
}

export interface KycBackfillResult {
  dryRun: boolean;
  /** Partner rows that still held at least one legacy plaintext value. */
  rowsWithPlaintext: number;
  /** Fields for which ciphertext was (or, in a dry run, would be) written. */
  fieldsEncrypted: number;
  /** Fields whose existing ciphertext already matches the plaintext. */
  fieldsAlreadyEncrypted: number;
  /** Legacy plaintext values set to NULL. */
  plaintextNulled: number;
  /** Ciphertext present but NOT decrypting to the plaintext — left untouched; needs a human. */
  mismatches: number;
}

/**
 * Migrates rows written before SEC-02. Idempotent and safe to re-run after
 * every deploy, since an old release may keep writing plaintext until it is
 * replaced. Never logs or returns a value — counts only.
 *
 * Recommended sequence (see DEPLOYMENT.md): back up the database, run with
 * `apply`, confirm `mismatches` is 0, then run again with `nullPlaintext`.
 */
export async function backfillDeliveryPartnerKyc(
  options: KycBackfillOptions = {},
): Promise<KycBackfillResult> {
  const apply = Boolean(options.apply || options.nullPlaintext);
  const nullPlaintext = Boolean(options.nullPlaintext);

  if (!isPanEncryptionConfigured()) {
    throw new Error("PAN_ENCRYPTION_KEY must be configured to run the KYC backfill.");
  }

  const result: KycBackfillResult = {
    dryRun: !apply,
    rowsWithPlaintext: 0,
    fieldsEncrypted: 0,
    fieldsAlreadyEncrypted: 0,
    plaintextNulled: 0,
    mismatches: 0,
  };

  const rows = await db
    .select()
    .from(deliveryPartners)
    .where(or(...KYC_FIELDS.map((field) => isNotNull(deliveryPartners[field]))));
  result.rowsWithPlaintext = rows.length;

  for (const row of rows) {
    for (const field of KYC_FIELDS) {
      const plaintext = row[field];
      if (plaintext == null) continue;

      const key = encryptedKey(field);
      let ciphertext = row[key];

      if (ciphertext == null) {
        result.fieldsEncrypted += 1;
        if (!apply) continue;
        ciphertext = encryptSecret(plaintext);
        const written = await db
          .update(deliveryPartners)
          .set({ [key]: ciphertext })
          .where(and(eq(deliveryPartners.id, row.id), eq(deliveryPartners[field], plaintext)))
          .returning({ id: deliveryPartners.id });
        if (written.length === 0) continue; // row changed underneath us; the next run picks it up
      } else if (safeDecrypt(ciphertext) === plaintext) {
        result.fieldsAlreadyEncrypted += 1;
      } else {
        result.mismatches += 1;
        continue;
      }

      if (nullPlaintext && safeDecrypt(ciphertext) === plaintext) {
        const nulled = await db
          .update(deliveryPartners)
          .set({ [field]: null })
          .where(and(eq(deliveryPartners.id, row.id), eq(deliveryPartners[field], plaintext)))
          .returning({ id: deliveryPartners.id });
        result.plaintextNulled += nulled.length;
      }
    }
  }

  return result;
}

function safeDecrypt(encoded: string): string | null {
  try {
    return decryptSecret(encoded);
  } catch {
    return null;
  }
}
