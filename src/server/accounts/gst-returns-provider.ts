/**
 * The GST returns adapter (docs/inventory-accounting-2026-10, Part 3): reading
 * GSTR-2B / 2A / 1 from the GST system through a licensed GSP, behind one
 * interface so the provider can be swapped by configuration.
 *
 *   GST_RETURNS_PROVIDER=none   API off: owners upload the file they download
 *                                from gst.gov.in (the fallback). The default on
 *                                gokesari.com.
 *   GST_RETURNS_PROVIDER=mock   sandbox-shaped answers, no network (test only;
 *                                refused on the production host). The default
 *                                elsewhere while GSP_PROVIDER is the mock.
 *   GST_RETURNS_PROVIDER=<gsp>  a licensed GSP's adapter, once contracted —
 *                                masters_india, cleartax, iris, … register here
 *                                (they answer NOT_CONFIGURED until implemented
 *                                with that GSP's credentials: GSP_RETURNS_*).
 *
 * The taxpayer flow is the GSTN one: the owner gives consent and their portal
 * username, the GSP asks the GST system to send an OTP to the mobile
 * registered on the portal, the owner types it, and the session token that
 * comes back (valid for hours, renewable) is kept encrypted.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, gte, lt } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import type { ParsedPortalFile, PortalInvoice, PortalReturnType } from "@/lib/gst/portal-parsers";
import { periodRange } from "@/lib/accounts/gst-liability";
import { db } from "@/server/db";
import { accPurchaseInvoices } from "@/server/db/schema";
import { GspError } from "@/server/gst/gsp/types";

export interface PortalSession {
  authToken: string;
  /** ISO time the token stops working. */
  expiresAt: string;
}

export interface GstReturnsProvider {
  readonly name: string;
  requestOtp(gstin: string, username: string): Promise<{ requestId: string }>;
  verifyOtp(gstin: string, username: string, requestId: string, otp: string): Promise<PortalSession>;
  fetchReturn(session: PortalSession, gstin: string, returnType: PortalReturnType, period: string, shopId: string): Promise<ParsedPortalFile>;
}

/* ----------------------------------------------------------------- mock */

/** The OTP the mock accepts (as the GSTN sandbox's default). */
export const MOCK_GST_OTP = "575757";

/**
 * Mock: OTP 575757 links any well-formed GSTIN. GSTR-2B / 2A answer with the
 * shop's own confirmed bills of that month as suppliers reported them —
 * except, deterministically, every second bill reported ₹10 higher (amount
 * mismatch), the last one not reported (missing on portal) — plus one
 * invoice that is not in the books (missing in books). That exercises every
 * reconciliation outcome on test.gokesari.com without a GSP contract.
 */
function createMockProvider(): GstReturnsProvider {
  const pending = new Map<string, string>();
  return {
    name: "mock",
    async requestOtp(gstin, username) {
      const requestId = randomBytes(8).toString("hex");
      pending.set(requestId, `${gstin}|${username}`);
      return { requestId };
    },
    async verifyOtp(gstin, username, requestId, otp) {
      if (pending.get(requestId) !== `${gstin}|${username}`) throw new GspError("AUTH", "This OTP request has expired. Ask for a new OTP.");
      if (otp !== MOCK_GST_OTP) throw new GspError("AUTH", "Wrong OTP.");
      pending.delete(requestId);
      return { authToken: createHash("sha256").update(`${gstin}${requestId}`).digest("hex"), expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString() };
    },
    async fetchReturn(_session, gstin, returnType, period, shopId) {
      const { from, to } = periodRange(period);
      const bills =
        returnType === "GSTR1"
          ? []
          : await db
              .select()
              .from(accPurchaseInvoices)
              .where(and(eq(accPurchaseInvoices.shopId, shopId), eq(accPurchaseInvoices.status, "CONFIRMED"), gte(accPurchaseInvoices.invoiceDate, from), lt(accPurchaseInvoices.invoiceDate, to)))
              .orderBy(accPurchaseInvoices.invoiceDate, accPurchaseInvoices.createdAt);
      const withGstin = bills.filter((b) => b.supplierGstin);
      const invoices: PortalInvoice[] = withGstin.slice(0, Math.max(0, withGstin.length - 1)).map((b, i) => {
        const bump = i % 2 === 1 ? 1000 : 0;
        return {
          section: "B2B",
          counterpartyGstin: b.supplierGstin!,
          counterpartyName: b.supplierName,
          invoiceNo: b.invoiceNo,
          invoiceDate: b.invoiceDate,
          docType: "INV",
          placeOfSupply: b.placeOfSupply,
          reverseCharge: b.reverseCharge,
          taxablePaise: b.taxablePaise + bump,
          igstPaise: b.igstPaise,
          cgstPaise: b.cgstPaise,
          sgstPaise: b.sgstPaise,
          cessPaise: b.cessPaise,
          totalPaise: b.totalPaise + bump,
          itcAvailable: true,
          itcUnavailableReason: null,
          irn: b.irn,
          rates: [],
        };
      });
      invoices.push({
        section: "B2B",
        counterpartyGstin: "27AAPFU0939F1ZV",
        counterpartyName: "MOCK SUPPLIER NOT IN BOOKS",
        invoiceNo: `MOCK/${period.replace("-", "")}/1`,
        invoiceDate: `${period}-05`,
        docType: "INV",
        placeOfSupply: gstin.slice(0, 2),
        reverseCharge: false,
        taxablePaise: 100_000,
        igstPaise: 0,
        cgstPaise: 9_000,
        sgstPaise: 9_000,
        cessPaise: 0,
        totalPaise: 118_000,
        itcAvailable: true,
        itcUnavailableReason: null,
        irn: null,
        rates: [{ rateBp: 1800, taxablePaise: 100_000, igstPaise: 0, cgstPaise: 9_000, sgstPaise: 9_000, cessPaise: 0 }],
      });
      return { returnType, gstin, period, invoices, warnings: ["Mock GSP: sandbox data, not from the GST portal."] };
    },
  };
}

/** A GSP adapter slot that is configured but not implemented yet (needs the GSP's API contract). */
function notImplemented(name: string): GstReturnsProvider {
  const fail = async (): Promise<never> => {
    throw new GspError("NOT_CONFIGURED", `The ${name} GSP adapter needs that GSP's API contract and credentials (GSP_RETURNS_CLIENT_ID / GSP_RETURNS_CLIENT_SECRET). Until then, upload the file from gst.gov.in.`);
  };
  return { name, requestOtp: fail, verifyOtp: fail, fetchReturn: fail };
}

const KNOWN_GSPS = ["masters_india", "cleartax", "iris", "tally_gsp", "vayana"] as const;

let override: GstReturnsProvider | null = null;
let mock: GstReturnsProvider | null = null;

/** Tests only. */
export function setGstReturnsProviderForTests(provider: GstReturnsProvider | null): void {
  override = provider;
}

function onProductionHost(): boolean {
  const env = getEnv();
  try {
    const host = env.AUTH_URL ? new URL(env.AUTH_URL).hostname.toLowerCase() : "";
    const prod = env.KYC_PRODUCTION_HOST.toLowerCase();
    return host === prod || host === `www.${prod}`;
  } catch {
    return false;
  }
}

export function gstReturnsProviderName(): string {
  if (override) return override.name;
  const explicit = process.env.GST_RETURNS_PROVIDER?.trim().toLowerCase();
  if (explicit) return explicit;
  // Unset: follow the e-invoice GSP. Where that is the sandbox mock (test.gokesari.com,
  // local), returns use the mock too; the production host never runs the mock (below).
  return getEnv().GSP_PROVIDER === "mock" && !onProductionHost() ? "mock" : "none";
}

/** The configured provider, or null when the API is off (owners upload files). */
export function getGstReturnsProvider(): GstReturnsProvider | null {
  if (override) return override;
  const name = gstReturnsProviderName();
  if (name === "none" || name === "off") return null;
  if (name === "mock") {
    if (onProductionHost()) return null;
    mock ??= createMockProvider();
    return mock;
  }
  if ((KNOWN_GSPS as readonly string[]).includes(name)) return notImplemented(name);
  return null;
}
