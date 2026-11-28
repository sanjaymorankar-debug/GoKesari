"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { SchemeChooser, type ChooserCharge, type ChooserScheme } from "@/components/dealer/scheme-chooser";
import { SchemeQuestions } from "@/components/dealer/scheme-questions";
import { FromShopDetailsCard, type FromShopDetails } from "@/components/dealer/from-shop-details";
import type { CustomField, CustomValues } from "@/lib/dealer-schemes";
import { DEALER_DOC_LABELS, DEALER_TYPE_LABELS, DEALER_TYPES, type DealerDocType, type DealerType } from "@/lib/dealers";

export interface ApplicationDealer {
  status: string;
  statusLabel: string;
  statusReason: string | null;
  legalName: string;
  contactName: string;
  dealerType: DealerType;
  mobileMasked: string | null;
  mobileVerified: boolean;
  panMasked: string | null;
  gstin: string | null;
  shopActNumber: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; pincode: string | null; state: string | null };
  bank: { holderName: string | null; accountMasked: string | null; ifsc: string | null; status: string; reason: string | null };
  territories: string[];
  requirements: { docType: DealerDocType; label: string; required: boolean; status: string }[];
  documents: { id: string; docType: DealerDocType; fileName: string; status: string; reviewNote: string | null }[];
  /** Latest online check of his PAN / GSTIN (22-Nov-2026). */
  onlineChecks?: { docType: "PAN" | "GSTIN"; status: string; matchedName: string | null; current: boolean }[];
  /** Zones he bought as a paid franchise: his working area, so no area is asked. */
  franchiseZones?: { id: string; name: string }[];
}

interface Props {
  dealer: ApplicationDealer | null;
  requirements: Record<DealerType, { docType: DealerDocType; required: boolean }[]>;
  areas: { code: string; name: string; parent: string | null }[];
  agreementVersion: string;
  smsAvailable: boolean;
  /** The franchise zone he chose to work in free (Book a franchise zone → Free dealership), with its name. */
  workZone?: { id: string; name: string } | null;
  /** The bank account can be checked online on this site (Cashfree Verification keys set). */
  bankCheckAvailable?: boolean;
  /** docs/dealer-platform phase 2: the schemes to choose from, his choice and its joining charge (null: franchise owner). */
  scheme?: {
    schemes: ChooserScheme[];
    chosenVersionId: string | null;
    charge: ChooserCharge | null;
    /** Phase 5: the chosen scheme's own questions. */
    questions?: { fields: CustomField[]; values: CustomValues; files: { id: string; fieldKey: string; fileName: string }[] } | null;
  } | null;
  /** Owner, 28-Nov-2026: the applicant's live shop details — shown read-only and not asked again. */
  fromShop?: FromShopDetails | null;
}

/** Documents that can be checked online instead of uploaded, and what the check uses. */
const ONLINE: Partial<Record<DealerDocType, { target: "PAN" | "GSTIN" | "BANK"; button: string; how: string }>> = {
  PAN: { target: "PAN", button: "Verify PAN online", how: "Checks the PAN from step 1 with the Income Tax record." },
  GSTIN: { target: "GSTIN", button: "Verify GSTIN online", how: "Checks the GSTIN from step 1 with the GST record." },
  BANK_PROOF: { target: "BANK", button: "Verify with the bank", how: "Checks the account from step 1 with the bank (account valid and in your name)." },
};

const EDITABLE = ["DRAFT", "REJECTED"];

/**
 * Dealer application (docs/dealer-programme, GKS-DR-001/002): 1. details and
 * bank account, 2. the mobile code, 3. documents for the dealer type, 4. the
 * agreement and submit. PAN and the account number are typed in again only
 * when they change — the saved ones are shown masked.
 */
export function DealerApplication({ dealer, requirements, areas, agreementVersion, smsAvailable, workZone = null, bankCheckAvailable = false, scheme = null, fromShop = null }: Props) {
  const router = useRouter();
  const editable = !dealer || EDITABLE.includes(dealer.status);
  // What the shop already holds is shown read-only ("from your shop") and filled in on the server.
  const shop = editable ? fromShop : null;
  const fromShopHas = {
    names: !!shop,
    mobile: !!shop?.mobileMasked,
    pan: !!shop?.panMasked,
    gstin: !!shop?.gstin,
    address: !!(shop?.address.line1 && shop.address.city && shop.address.pincode),
    bank: !!shop?.bank,
  };
  const [form, setForm] = useState({
    legalName: dealer?.legalName ?? shop?.legalName ?? "",
    contactName: dealer?.contactName ?? shop?.contactName ?? "",
    dealerType: (dealer?.dealerType ?? (shop ? (shop.gstin ? "PROPRIETORSHIP" : "INDIVIDUAL") : "PROPRIETORSHIP")) as DealerType,
    mobile: "",
    pan: "",
    gstin: dealer?.gstin ?? shop?.gstin ?? "",
    shopActNumber: dealer?.shopActNumber ?? "",
    addressLine1: dealer?.address.line1 ?? shop?.address.line1 ?? "",
    addressLine2: dealer?.address.line2 ?? "",
    city: dealer?.address.city ?? shop?.address.city ?? "",
    pincode: dealer?.address.pincode ?? shop?.address.pincode ?? "",
    bankHolderName: dealer?.bank.holderName ?? "",
    bankAccountNumber: "",
    bankIfsc: dealer?.bank.ifsc ?? "",
  });
  const [territories, setTerritories] = useState<string[]>(dealer?.territories ?? []);
  const [pickedState, setPickedState] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function send(url: string, init: RequestInit, label: string, done: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, init);
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const missing: string[] | undefined = payload?.error?.details?.missing;
        throw new Error(payload?.error?.message ?? (missing ? `Missing: ${missing.join(", ")}` : "That did not work."));
      }
      setNotice(done);
      router.refresh();
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const needsMobile = (!dealer?.mobileMasked && !fromShopHas.mobile) || form.mobile.trim() !== "";
    if (needsMobile && !form.mobile.trim()) return setError("Enter your mobile number.");
    const body = {
      legalName: form.legalName,
      contactName: form.contactName,
      dealerType: form.dealerType,
      mobile: form.mobile.trim() || null,
      pan: form.pan.trim() || null,
      gstin: form.gstin.trim() || null,
      shopActNumber: form.shopActNumber.trim() || null,
      addressLine1: form.addressLine1,
      addressLine2: form.addressLine2 || null,
      city: form.city,
      pincode: form.pincode,
      territories,
      ...(workZone ? { preferredZoneId: workZone.id } : {}),
      bank: form.bankAccountNumber.trim() && !fromShopHas.bank
        ? { holderName: form.bankHolderName, accountNumber: form.bankAccountNumber, ifsc: form.bankIfsc }
        : null,
    };
    await send("/api/dealer/application", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, "save", "Saved.");
  }

  async function checkOnline(target: "PAN" | "GSTIN" | "BANK") {
    setBusy(`check-${target}`);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/dealer/application/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "The check did not work.");
      const result: { status: string; message: string } = payload.data?.result ?? payload.result;
      if (result.status === "VERIFIED") setNotice(result.message);
      else setError(result.message);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The check did not work.");
    } finally {
      setBusy(null);
    }
  }

  async function upload(docType: DealerDocType, file: File | undefined) {
    if (!file) return;
    const data = new FormData();
    data.set("docType", docType);
    data.set("file", file);
    await send("/api/dealer/application/documents", { method: "POST", body: data }, `doc-${docType}`, `${DEALER_DOC_LABELS[docType]} uploaded.`);
  }

  const reqs = dealer?.requirements ?? requirements[form.dealerType].map((r) => ({ ...r, label: DEALER_DOC_LABELS[r.docType], status: "MISSING" }));
  const byParent = new Map<string | null, typeof areas>();
  for (const a of areas) byParent.set(a.parent, [...(byParent.get(a.parent) ?? []), a]);
  // States first (parent null); then the chosen state's districts with their cities and localities.
  const states = areas.filter((a) => a.parent === null);
  const chosenState = pickedState ?? states.find((s) => territories.some((t) => t === s.code || t.startsWith(`${s.code}-`)))?.code ?? (states.length === 1 ? states[0].code : "");
  const districts = chosenState ? (byParent.get(chosenState) ?? []) : [];
  const ownedZones = dealer?.franchiseZones ?? [];
  const chosenScheme = scheme?.schemes.find((x) => x.versionId === scheme.chosenVersionId) ?? null;
  const unpaid = Boolean(scheme?.charge?.required && scheme.charge.status !== "PAID");
  const toggle = (code: string, on: boolean) => setTerritories((t) => (on ? [...t, code] : t.filter((c) => c !== code)));

  return (
    <div className="space-y-4" data-testid="dealer-application">
      {error ? <Alert tone="danger" title="Could not save">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {dealer ? (
        <Card className="flex flex-wrap items-center gap-2 p-4">
          <span className="text-sm font-semibold text-ink-900">Application:</span>
          <Badge tone={dealer.status === "APPROVED" ? "success" : dealer.status === "REJECTED" ? "danger" : "warning"}>{dealer.statusLabel}</Badge>
          {dealer.statusReason ? <span className="text-sm text-ink-700">Reason: {dealer.statusReason}</span> : null}
        </Card>
      ) : null}

      {scheme && scheme.schemes.length ? (
        // Before the first save there is no application to attach the choice to: the schemes are shown to compare.
        <SchemeChooser schemes={scheme.schemes} chosenVersionId={scheme.chosenVersionId} charge={scheme.charge} editable={editable && Boolean(dealer)} />
      ) : null}
      {scheme?.questions && dealer ? <SchemeQuestions fields={scheme.questions.fields} values={scheme.questions.values} files={scheme.questions.files} editable={editable} /> : null}

      {workZone ? (
        <Card className="space-y-1 p-4" data-testid="dealer-work-zone">
          <p className="text-sm font-semibold text-ink-900">
            Free dealership · working zone {workZone.name} ({workZone.id})
          </p>
          <p className="text-xs text-ink-600">No fee and no zone ownership: you earn the one-time commission on the shops you and your team register. Saved with your application. Want to own the zone instead? <a className="underline" href={`/franchise/book?zones=${encodeURIComponent(workZone.id)}&join=paid`}>Buy it as a franchise</a>.</p>
        </Card>
      ) : null}

      {shop ? <FromShopDetailsCard details={shop} /> : null}

      <Card className="space-y-3 p-4">
        <h2 className="text-base font-bold text-ink-900">1. Your business</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {fromShopHas.names ? null : (
            <>
              <Field label="Legal / business name">
                <input className={inputClass} value={form.legalName} onChange={set("legalName")} disabled={!editable} maxLength={120} />
              </Field>
              <Field label="Owner / representative name">
                <input className={inputClass} value={form.contactName} onChange={set("contactName")} disabled={!editable} maxLength={120} />
              </Field>
            </>
          )}
          <Field label="Dealer type" hint="The documents you need depend on it.">
            <select className={inputClass} value={form.dealerType} onChange={set("dealerType")} disabled={!editable}>
              {DEALER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DEALER_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          {fromShopHas.mobile ? null : (
            <Field label="Mobile number" hint={dealer?.mobileMasked ? `Saved: ${dealer.mobileMasked}. Type a new one only to change it.` : "10 digits."}>
              <input className={inputClass} inputMode="numeric" value={form.mobile} onChange={set("mobile")} disabled={!editable} maxLength={14} />
            </Field>
          )}
          {fromShopHas.pan ? null : (
            <Field label="PAN" hint={dealer?.panMasked ? `Saved: ${dealer.panMasked}. Type it again only to change it.` : "e.g. ABCDE1234F"}>
              <input className={inputClass} value={form.pan} onChange={set("pan")} disabled={!editable} maxLength={10} autoComplete="off" />
            </Field>
          )}
          {fromShopHas.gstin ? null : (
            <Field label="GSTIN (if registered)">
              <input className={inputClass} value={form.gstin} onChange={set("gstin")} disabled={!editable} maxLength={15} />
            </Field>
          )}
          <Field label="Shop & Establishment number (if any)">
            <input className={inputClass} value={form.shopActNumber} onChange={set("shopActNumber")} disabled={!editable} maxLength={60} />
          </Field>
          {fromShopHas.address ? null : (
            <>
              <Field label="Registered address">
                <input className={inputClass} value={form.addressLine1} onChange={set("addressLine1")} disabled={!editable} maxLength={200} />
              </Field>
              <Field label="Address line 2 (optional)">
                <input className={inputClass} value={form.addressLine2} onChange={set("addressLine2")} disabled={!editable} maxLength={200} />
              </Field>
              <Field label="City">
                <input className={inputClass} value={form.city} onChange={set("city")} disabled={!editable} maxLength={80} />
              </Field>
              <Field label="PIN code">
                <input className={inputClass} inputMode="numeric" value={form.pincode} onChange={set("pincode")} disabled={!editable} maxLength={6} />
              </Field>
            </>
          )}
        </div>

        {ownedZones.length ? (
          <div className="rounded-xl border border-cream-200 p-3" data-testid="dealer-franchise-area">
            <p className="text-sm font-semibold text-ink-900">Where you will work: your franchise {ownedZones.length === 1 ? "zone" : "zones"}</p>
            <p className="text-sm text-ink-700">{ownedZones.map((z) => `${z.name} (${z.id})`).join(", ")}</p>
            <p className="text-xs text-ink-500">You booked {ownedZones.length === 1 ? "this zone" : "these zones"}, so there is no other area to choose.</p>
          </div>
        ) : (
        <fieldset>
          <legend className="text-sm font-semibold text-ink-900">Where you will work</legend>
          <p className="text-xs text-ink-500">Several dealers may work in the same area; no area is exclusive.</p>
          <Field label="State / union territory">
            <select className={inputClass} disabled={!editable} value={chosenState} onChange={(e) => setPickedState(e.target.value)} aria-label="State">
              <option value="">Choose…</option>
              {states.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="mt-2 space-y-2">
            {chosenState ? (
              <label className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold">
                <input type="checkbox" disabled={!editable} checked={territories.includes(chosenState)} onChange={(e) => toggle(chosenState, e.target.checked)} />
                {states.find((s) => s.code === chosenState)?.name} (whole state)
              </label>
            ) : null}
            {chosenState && districts.length === 0 ? <p className="text-xs text-ink-500">No districts listed for this state yet — choose the whole state; GoKesari adds your district when it approves you.</p> : null}
            {districts.map((d) => (
              <div key={d.code} className="rounded-xl border border-cream-200 p-2">
                <label className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold">
                  <input
                    type="checkbox"
                    disabled={!editable}
                    checked={territories.includes(d.code)}
                    onChange={(e) => setTerritories((t) => (e.target.checked ? [...t, d.code] : t.filter((c) => c !== d.code)))}
                  />
                  {d.name} (whole district)
                </label>
                <div className="flex flex-wrap gap-x-4">
                  {(byParent.get(d.code) ?? []).flatMap((city) => [city, ...(byParent.get(city.code) ?? [])]).map((a) => (
                    <label key={a.code} className="inline-flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        disabled={!editable}
                        checked={territories.includes(a.code)}
                        onChange={(e) => setTerritories((t) => (e.target.checked ? [...t, a.code] : t.filter((c) => c !== a.code)))}
                      />
                      {a.name}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
        )}

        <h3 id="bank" className="scroll-mt-20 pt-2 text-sm font-semibold text-ink-900">Bank account for your commission</h3>
        {dealer?.bank.accountMasked ? (
          <p className="text-sm text-ink-700">
            Saved: {dealer.bank.accountMasked} ({dealer.bank.ifsc}) — {dealer.bank.status.toLowerCase().replace("_", " ")}
            {dealer.bank.reason ? `: ${dealer.bank.reason}` : ""}
          </p>
        ) : null}
        {fromShopHas.bank && shop?.bank ? (
          <p className="text-sm text-ink-700" data-testid="dealer-bank-from-shop">
            Your shop&apos;s verified payout account {shop.bank.accountMasked} ({shop.bank.ifsc}) is used — from your shop, already verified by the bank.
          </p>
        ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Account holder">
            <input className={inputClass} value={form.bankHolderName} onChange={set("bankHolderName")} disabled={!editable} maxLength={120} />
          </Field>
          <Field label="Account number" hint={dealer?.bank.accountMasked ? "Type it only to change the account." : undefined}>
            <input className={inputClass} inputMode="numeric" value={form.bankAccountNumber} onChange={set("bankAccountNumber")} disabled={!editable} maxLength={18} autoComplete="off" />
          </Field>
          <Field label="IFSC">
            <input className={inputClass} value={form.bankIfsc} onChange={set("bankIfsc")} disabled={!editable} maxLength={11} />
          </Field>
        </div>
        )}
        {editable ? (
          <Button onClick={save} disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save details"}
          </Button>
        ) : null}
      </Card>

      {dealer ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-bold text-ink-900">2. Verify your mobile number</h2>
          {dealer.mobileVerified ? (
            <p className="text-sm text-leaf-700">Verified: {dealer.mobileMasked}</p>
          ) : smsAvailable ? (
            <div className="flex flex-wrap items-end gap-2">
              <Button
                variant="secondary"
                disabled={busy !== null || !editable}
                onClick={async () => {
                  if (await send("/api/dealer/application/otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "send" }) }, "otp", `Code sent to ${dealer.mobileMasked}.`)) setOtpSent(true);
                }}
              >
                {otpSent ? "Send again" : "Send code"}
              </Button>
              <label className="block">
                <span className="mb-1 block text-xs text-ink-500">Code</span>
                <input className={inputClass} inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value)} maxLength={8} autoComplete="one-time-code" />
              </label>
              <Button
                disabled={busy !== null || !otp.trim()}
                onClick={() => send("/api/dealer/application/otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "verify", code: otp.trim() }) }, "verify", "Mobile number verified.")}
              >
                Verify
              </Button>
            </div>
          ) : (
            <p className="text-sm text-ink-700">Text messages are not available right now; our team will confirm your number by phone.</p>
          )}
        </Card>
      ) : null}

      {dealer ? (
        <Card id="documents" className="scroll-mt-20 space-y-3 p-4">
          <h2 className="text-base font-bold text-ink-900">3. Documents</h2>
          <p className="text-xs text-ink-500">
            Verify online where offered (no upload needed once verified), or upload: PDF, JPEG, PNG or WebP, up to 5 MB each. Stored encrypted; only GoKesari&apos;s
            authorised staff can open them.
          </p>
          <ul className="divide-y divide-cream-200">
            {reqs.map((r) => {
              const latest = dealer.documents.find((d) => d.docType === r.docType);
              const open = ["DRAFT", "REJECTED", "PENDING"].includes(dealer.status);
              const online = ONLINE[r.docType];
              const verifiedOnline = r.status === "VERIFIED_ONLINE";
              const check = online && online.target !== "BANK" ? dealer.onlineChecks?.find((c) => c.docType === online.target && c.current) : undefined;
              const canCheck =
                online &&
                !verifiedOnline &&
                (online.target === "PAN" ? !!dealer.panMasked : online.target === "GSTIN" ? !!dealer.gstin : bankCheckAvailable && !!dealer.bank.accountMasked);
              return (
                <li key={r.docType} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`dealer-doc-${r.docType}`}>
                  <span className="text-sm">
                    <span className="font-semibold text-ink-900">{r.label}</span> {r.required ? <Badge tone="warning">Required</Badge> : <Badge>Optional</Badge>}{" "}
                    {verifiedOnline ? (
                      <Badge tone="success">verified online</Badge>
                    ) : latest ? (
                      <Badge tone={latest.status === "ACCEPTED" ? "success" : latest.status === "REJECTED" ? "danger" : "info"}>{latest.status.toLowerCase()}</Badge>
                    ) : null}
                    {latest?.reviewNote && !verifiedOnline ? <span className="block text-xs text-red-700">{latest.reviewNote}</span> : null}
                    {verifiedOnline && r.docType === "ADDRESS_PROOF" ? <span className="block text-xs text-ink-500">Your GSTIN verified online carries your registered address.</span> : null}
                    {!verifiedOnline && r.docType === "ADDRESS_PROOF" && open ? (
                      <span className="block text-xs text-ink-500">Have a GSTIN? Verify it online above and no address proof upload is needed.</span>
                    ) : null}
                    {check && check.status !== "VERIFIED" ? (
                      <span className="block text-xs text-red-700">
                        Online check: {check.status === "NAME_MISMATCH" ? `the name on the record (${check.matchedName ?? "—"}) does not match` : check.status === "FAILED" ? "not verified" : "could not be done"}
                      </span>
                    ) : null}
                    {canCheck && open ? <span className="block text-xs text-ink-500">{online.how}</span> : null}
                    {online && !canCheck && !verifiedOnline && open ? (
                      <span className="block text-xs text-ink-500">
                        {online.target === "BANK" && !bankCheckAvailable ? "The online bank check is not available yet; upload the proof." : `Save your ${online.target === "BANK" ? "bank account" : online.target} in step 1 to verify it online.`}
                      </span>
                    ) : null}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                  {open && canCheck ? (
                    <Button variant="secondary" disabled={busy !== null} onClick={() => checkOnline(online.target)}>
                      {busy === `check-${online.target}` ? "Checking…" : online.button}
                    </Button>
                  ) : null}
                  {open && !verifiedOnline ? (
                    <label className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-cream-200 px-3 text-sm font-medium text-ink-700 hover:bg-cream-100">
                      {busy === `doc-${r.docType}` ? "Uploading…" : latest ? "Replace" : "Upload"}
                      <input
                        type="file"
                        accept="application/pdf,image/jpeg,image/png,image/webp"
                        className="sr-only"
                        aria-label={`Upload ${r.label}`}
                        onChange={(e) => upload(r.docType, e.target.files?.[0])}
                      />
                    </label>
                  ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {dealer && dealer.status === "DRAFT" ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-bold text-ink-900">4. Agreement and submit</h2>
          <p className="text-sm text-ink-700">
            As an authorised GoKesari dealer you introduce shops to GoKesari, with your own staff and devices. You earn a one-time
            commission for each shop that completes the agreed onboarding milestones, at the rates GoKesari sets. You may not
            recruit other dealers. Shop owners register and pay their own registration fee; you never collect money for GoKesari.
            GoKesari may suspend or end the authorisation as the agreement provides. (Agreement version {agreementVersion}.)
          </p>
          {chosenScheme ? (
            <p className="text-sm text-ink-700" data-testid="dealer-accept-scheme">
              Your scheme: <span className="font-semibold">{chosenScheme.name}</span> (version {chosenScheme.version}). Its terms, shown above, are part of the agreement.
            </p>
          ) : null}
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />I have read and accept the dealer agreement{chosenScheme ? " and my scheme's terms" : ""}.
          </label>
          <Button
            disabled={!accept || busy !== null || unpaid}
            onClick={() =>
              send(
                "/api/dealer/application/submit",
                { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agreementVersion, termsHash: chosenScheme?.termsHash ?? null }) },
                "submit",
                "Application submitted. We will tell you when it is decided.",
              )
            }
          >
            {busy === "submit" ? "Submitting…" : "Submit application"}
          </Button>
        </Card>
      ) : null}
    </div>
  );
}
