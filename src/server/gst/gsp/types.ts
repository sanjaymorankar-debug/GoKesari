/**
 * The GST Suvidha Provider interface (Module 2). GoKesari talks to the GST
 * system (GSTIN search, e-invoice IRP, e-way bill) only through a licensed
 * GSP, behind this interface — so the GSP can be chosen or changed without
 * touching the invoicing code. `mock` answers like a sandbox and makes no
 * network call; the real adapter is added once a GSP is chosen
 * (docs/three-modules-2026-10/PLAN.md, pending actions).
 */
import type { CanonicalInvoice } from "@/server/integrations/canonical";

export interface GstinDetails {
  gstin: string;
  found: boolean;
  legalName: string | null;
  tradeName: string | null;
  /** As the portal says it: "Active", "Cancelled", "Suspended", "Inactive". */
  status: string | null;
  stateCode: string | null;
  /** "Regular", "Composition", "Input Service Distributor", … */
  taxpayerType: string | null;
  /** YYYY-MM-DD */
  registrationDate: string | null;
  address: string | null;
  raw?: Record<string, unknown>;
}

export interface IrnRequest {
  /** Our idempotency key: the same request id always yields the same IRN. */
  requestId: string;
  invoice: CanonicalInvoice;
}

export interface IrnResult {
  irn: string;
  ackNo: string;
  /** ISO timestamp */
  ackDate: string;
  signedInvoice: string;
  signedQr: string;
}

export interface EwayBillRequest {
  requestId: string;
  invoice: CanonicalInvoice;
  /** Approximate road distance seller → buyer, km. */
  distanceKm: number;
  vehicleNo?: string | null;
  transporterId?: string | null;
  /** Part-A only (no vehicle yet) when absent. */
  irn?: string | null;
}

export interface EwayBillResult {
  ewbNo: string;
  /** ISO timestamp */
  validUpto: string;
}

export type GspErrorCode = "NOT_CONFIGURED" | "AUTH" | "INVALID" | "DUPLICATE" | "UNAVAILABLE";

export class GspError extends Error {
  readonly code: GspErrorCode;
  readonly retryable: boolean;
  readonly detail: string | null;
  constructor(code: GspErrorCode, message: string, detail: string | null = null) {
    super(message);
    this.name = "GspError";
    this.code = code;
    this.retryable = code === "UNAVAILABLE";
    this.detail = detail;
  }
}

export interface GspProvider {
  readonly name: string;
  validateGstin(gstin: string): Promise<GstinDetails>;
  generateIrn(request: IrnRequest): Promise<IrnResult>;
  /** The IRN already generated for a document (after a DUPLICATE answer). */
  irnByDocument(sellerGstin: string, docType: "INV" | "CRN", docNumber: string, docDate: string): Promise<IrnResult | null>;
  cancelIrn(irn: string, reasonCode: "1" | "2" | "3" | "4", remark: string): Promise<{ cancelledAt: string }>;
  generateEwayBill(request: EwayBillRequest): Promise<EwayBillResult>;
  cancelEwayBill(ewbNo: string, reasonCode: "1" | "2" | "3" | "4", remark: string): Promise<{ cancelledAt: string }>;
}
