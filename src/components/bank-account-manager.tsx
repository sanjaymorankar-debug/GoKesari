"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import {
  BANK_STATUS_LABELS,
  VERIFICATION_METHODS,
  VERIFICATION_METHOD_LABELS,
  checkAccountNumber,
  checkIfsc,
  checkUpiId,
  type BankMethod,
  type VerificationMethod,
} from "@/lib/bank-accounts";
import { openCashfreeCheckout } from "@/lib/cashfree-checkout";

export interface BankAccountInfo {
  id: string;
  method: BankMethod;
  accountHolderName: string;
  accountNumberMasked: string | null;
  ifsc: string | null;
  upiIdMasked: string | null;
  status: "PENDING" | "VERIFIED" | "FAILED";
  matchedAccountHolderName: string | null;
  verifiedAt: string | null;
  verificationPaymentMethod: string | null;
  gatewayReference: string | null;
  failureReason: string | null;
  lastAttempt: { status: string; refundStatus: string; paymentMethod: string | null; createdAt: string } | null;
  /** O-7: how the account was decided (BANK_CHECK = checked with the bank) and the bank's latest answer. */
  matchMethod?: string | null;
  bankCheck?: {
    result: "VALID" | "INVALID" | "ERROR" | "NOT_CONFIGURED";
    nameAtBank: string | null;
    bankName: string | null;
    branch: string | null;
    checkedAt: string;
  } | null;
}

const TONE = { PENDING: "warning", VERIFIED: "success", FAILED: "danger" } as const;

/**
 * Bank account + ₹1 verification (docs/four-features-2026-10, feature 3), for
 * a customer (refunds) or a shop (payouts). Card details never touch this
 * page: payment happens in the gateway's own checkout. Without gateway keys
 * (test sites only) a labelled simulator stands in for it.
 */
export function BankAccountManager({
  account,
  saveUrl,
  gateway,
  purpose,
  bankCheck = false,
}: {
  account: BankAccountInfo | null;
  /** PUT endpoint: /api/bank-account or /api/shops/{id}/bank-account. */
  saveUrl: string;
  gateway: "CASHFREE" | "SIMULATOR" | "UNAVAILABLE";
  purpose: "refunds" | "payouts";
  /** O-7: a bank account is checked with the bank when saved (rule bankAccountCheck and its keys). */
  bankCheck?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(account == null);
  const [method, setMethod] = useState<BankMethod>(account?.method ?? "BANK_ACCOUNT");
  const [holder, setHolder] = useState(account?.accountHolderName ?? "");
  const [number, setNumber] = useState("");
  const [confirmNumber, setConfirmNumber] = useState("");
  const [ifsc, setIfsc] = useState(account?.ifsc ?? "");
  const [upi, setUpi] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [simulator, setSimulator] = useState<{ gatewayOrderId: string; amountPaise: number } | null>(null);
  const [simMethod, setSimMethod] = useState<VerificationMethod>("UPI");

  async function request(url: string, method: string, body: unknown) {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setFieldErrors(payload?.error?.details?.fields ?? {});
      throw new Error(payload?.error?.message ?? "Something went wrong.");
    }
    return payload;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    try {
      const saved = await request(saveUrl, "PUT", {
        method,
        accountHolderName: holder,
        ...(method === "BANK_ACCOUNT" ? { accountNumber: number, confirmAccountNumber: confirmNumber, ifsc } : { upiId: upi }),
      });
      setEditing(false);
      setNumber("");
      setConfirmNumber("");
      setUpi("");
      const checked = saved?.matchMethod === "BANK_CHECK";
      setNotice(
        checked && saved?.status === "VERIFIED"
          ? "Saved and verified with your bank — no ₹1 payment needed."
          : checked && saved?.status === "FAILED"
            ? null
            : saved?.bankCheck?.result === "ERROR"
              ? "Saved. We could not reach your bank just now — verify with ₹1 instead, or check with your bank again."
              : "Saved. Now verify it with a ₹1 payment, refunded straight away.",
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!account) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const intent = await request("/api/bank-account/verification", "POST", { accountId: account.id });
      if (intent.mode === "SIMULATOR") {
        setSimulator({ gatewayOrderId: intent.gatewayOrderId, amountPaise: intent.amountPaise });
        return;
      }
      await openCashfreeCheckout({ paymentSessionId: intent.paymentSessionId }, intent.cashfreeMode).catch(() => undefined);
      const result = await request("/api/bank-account/verification/confirm", "POST", { gatewayOrderId: intent.gatewayOrderId });
      setNotice(result.status === "VERIFIED" ? "Verified. The ₹1 is on its way back to you." : `Not verified: ${result.failureReason ?? "the payment did not go through"}. You can try again.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not verify.");
    } finally {
      setBusy(false);
    }
  }

  async function checkAgain() {
    if (!account) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await request("/api/bank-account/check", "POST", { accountId: account.id });
      setNotice(result?.status === "VERIFIED" ? "Verified with your bank — no ₹1 payment needed." : result?.bankCheck?.result === "ERROR" ? "We still could not reach your bank. Verify with ₹1 instead." : null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not check with your bank.");
    } finally {
      setBusy(false);
    }
  }

  async function simulate(outcome: "SUCCESS" | "FAILED" | "NAME_MISMATCH") {
    if (!simulator) return;
    setBusy(true);
    setError(null);
    try {
      const result = await request("/api/bank-account/verification/simulate", "POST", { gatewayOrderId: simulator.gatewayOrderId, method: simMethod, outcome });
      setSimulator(null);
      setNotice(result.status === "VERIFIED" ? "Verified. The ₹1 test payment was refunded." : `Not verified: ${result.failureReason}. You can try again.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not complete the test payment.");
    } finally {
      setBusy(false);
    }
  }

  const numberCheck = number ? checkAccountNumber(number) : null;
  const ifscCheck = ifsc ? checkIfsc(ifsc) : null;
  const upiCheck = upi ? checkUpiId(upi) : null;

  return (
    <div className="space-y-4" data-testid="bank-account">
      {account && !editing ? (
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-ink-900">{account.accountHolderName}</p>
              <p className="text-sm text-ink-600">
                {account.method === "UPI" ? `UPI ID ${account.upiIdMasked}` : `Account ${account.accountNumberMasked} · IFSC ${account.ifsc}`}
              </p>
            </div>
            <Badge tone={TONE[account.status]}>{BANK_STATUS_LABELS[account.status]}</Badge>
          </div>
          {account.status === "VERIFIED" && account.matchMethod === "BANK_CHECK" ? (
            <p className="mt-2 text-xs text-ink-500" data-testid="bank-check-verified">
              Verified with your bank{account.verifiedAt ? ` on ${new Date(account.verifiedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}
              {account.matchedAccountHolderName ? ` · name at bank ${account.matchedAccountHolderName}` : ""}
              {account.bankCheck?.bankName ? ` · ${account.bankCheck.bankName}${account.bankCheck.branch ? `, ${account.bankCheck.branch}` : ""}` : ""}
            </p>
          ) : account.status === "VERIFIED" ? (
            <p className="mt-2 text-xs text-ink-500">
              Verified{account.verifiedAt ? ` on ${new Date(account.verifiedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}
              {account.verificationPaymentMethod ? ` by ${VERIFICATION_METHOD_LABELS[account.verificationPaymentMethod as VerificationMethod] ?? account.verificationPaymentMethod}` : ""}
              {account.matchedAccountHolderName ? ` · name ${account.matchedAccountHolderName}` : ""}
              {account.gatewayReference ? ` · ref ${account.gatewayReference}` : ""}
              {account.lastAttempt ? ` · ₹1 refund ${account.lastAttempt.refundStatus.toLowerCase().replace(/_/g, " ")}` : ""}
            </p>
          ) : null}
          {account.status === "FAILED" && account.failureReason ? (
            <div className="mt-3" data-testid={account.matchMethod === "BANK_CHECK" ? "bank-check-failed" : undefined}>
              <Alert tone="danger" title={account.matchMethod === "BANK_CHECK" ? "Your bank did not confirm these details" : "Verification failed"}>
                {account.failureReason[0].toUpperCase() + account.failureReason.slice(1)}.
                {account.matchMethod === "BANK_CHECK" ? " Change the details to match your bank exactly, then save." : ""}
              </Alert>
            </div>
          ) : null}
          {account.status === "PENDING" && account.bankCheck?.result === "ERROR" ? (
            <p className="mt-2 text-xs text-amber-800" data-testid="bank-check-error">
              We could not reach your bank just now to check this account.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {account.status === "PENDING" && account.bankCheck?.result === "ERROR" ? (
              <Button variant="secondary" disabled={busy} onClick={() => void checkAgain()}>
                Check with my bank again
              </Button>
            ) : null}
            {account.status !== "VERIFIED" && !(account.status === "FAILED" && account.matchMethod === "BANK_CHECK") ? (
              <Button disabled={busy || gateway === "UNAVAILABLE"} onClick={() => void verify()}>
                {busy ? "Working…" : account.status === "FAILED" ? "Try again with ₹1" : "Verify with ₹1"}
              </Button>
            ) : null}
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
              Change details
            </Button>
          </div>
          {account.status !== "VERIFIED" ? (
            <p className="mt-2 text-xs text-ink-500">
              Pay ₹1 by UPI, debit card, credit card or net banking from this account. It is refunded straight away. Card details are
              entered in the payment gateway&apos;s secure window — never on GoKesari.
            </p>
          ) : null}
          {gateway === "UNAVAILABLE" ? <p className="mt-2 text-xs text-red-700">Payments are not set up on this site yet.</p> : null}
        </Card>
      ) : null}

      {simulator ? (
        <Card className="border-amber-300 p-5" data-testid="bank-simulator">
          <p className="text-sm font-semibold text-amber-900">TEST MODE — no money moves</p>
          <p className="mt-1 text-xs text-ink-600">
            This site has no payment gateway keys, so this simulator stands in for the gateway&apos;s checkout. Choose how the ₹
            {simulator.amountPaise / 100} is paid and what happens.
          </p>
          <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Payment method">
            {VERIFICATION_METHODS.map((m) => (
              <label key={m} className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${simMethod === m ? "border-kesari-500 bg-kesari-50" : "border-cream-200"}`}>
                <input type="radio" name="sim-method" className="sr-only" checked={simMethod === m} onChange={() => setSimMethod(m)} />
                {VERIFICATION_METHOD_LABELS[m]}
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void simulate("SUCCESS")}>
              Pay ₹1 — success
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void simulate("FAILED")}>
              Payment fails
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void simulate("NAME_MISMATCH")}>
              Paid by a different account holder
            </Button>
          </div>
        </Card>
      ) : null}

      {editing ? (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-ink-900">{account ? "Change bank details" : `Add a bank account for ${purpose}`}</h2>
          {account ? (
            <p className="mt-1 text-xs text-ink-500">
              {bankCheck ? "New bank account details are checked with your bank when you save (a UPI ID is verified with ₹1)." : "New details need a new ₹1 verification."}
            </p>
          ) : bankCheck ? (
            <p className="mt-1 text-xs text-ink-500">A bank account is checked with your bank as soon as you save it — no payment needed.</p>
          ) : null}
          <div className="mt-3 flex gap-2" role="radiogroup" aria-label="Account type">
            {(["BANK_ACCOUNT", "UPI"] as const).map((m) => (
              <label key={m} className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${method === m ? "border-kesari-500 bg-kesari-50" : "border-cream-200"}`}>
                <input type="radio" name="bank-method" className="sr-only" checked={method === m} onChange={() => setMethod(m)} />
                {m === "BANK_ACCOUNT" ? "Bank account" : "UPI ID"}
              </label>
            ))}
          </div>
          <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={save} autoComplete="off">
            <Field label="Account holder name" hint="Exactly as your bank has it" error={fieldErrors.accountHolderName}>
              <input className={inputClass} value={holder} onChange={(e) => setHolder(e.target.value)} required aria-label="Account holder name" />
            </Field>
            {method === "BANK_ACCOUNT" ? (
              <>
                <Field label="IFSC" error={fieldErrors.ifsc ?? (ifscCheck && !ifscCheck.ok ? ifscCheck.error : undefined)}>
                  <input className={inputClass} value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} maxLength={11} required aria-label="IFSC" />
                </Field>
                <Field label="Account number" error={fieldErrors.accountNumber ?? (numberCheck && !numberCheck.ok ? numberCheck.error : undefined)}>
                  <input className={inputClass} value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" type="password" required aria-label="Account number" />
                </Field>
                <Field label="Re-enter account number" error={fieldErrors.confirmAccountNumber ?? (confirmNumber && confirmNumber !== number ? "The two numbers do not match." : undefined)}>
                  <input className={inputClass} value={confirmNumber} onChange={(e) => setConfirmNumber(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" required aria-label="Re-enter account number" />
                </Field>
              </>
            ) : (
              <Field label="UPI ID" error={fieldErrors.upiId ?? (upiCheck && !upiCheck.ok ? upiCheck.error : undefined)}>
                <input className={inputClass} value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="name@bank" required aria-label="UPI ID" />
              </Field>
            )}
            <div className="flex items-end gap-2 sm:col-span-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
              {account ? (
                <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        </Card>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="info">{notice}</Alert> : null}
    </div>
  );
}
