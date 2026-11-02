/**
 * TallyPrime file connector (billing v2, docs/billing §8): the canonical books
 * as Tally XML (ENVELOPE / HEADER / BODY / IMPORTDATA / TALLYMESSAGE) — masters
 * first (groups, ledgers with opening balances and GSTIN, units with their GST
 * unit code, godowns, stock groups, stock items with HSN and GST rate and
 * opening stock), then vouchers with ledger, inventory and GST lines — and
 * Tally's own XML export read back into the canonical model for import.
 *
 * Tally's sign convention: a debit is a negative AMOUNT with ISDEEMEDPOSITIVE
 * Yes; a credit positive with No. A voucher keeps its own number (never
 * renumbered), and its REMOTEID is the canonical key, so importing the same
 * file twice alters the voucher instead of duplicating it.
 */
import { XMLParser } from "fast-xml-parser";

import { gstState } from "@/lib/gst-states";
import { xmlEscape } from "@/server/integrations/adapters/tally";
import type { CanonicalBooks, CLedger, CStockItem, CUnit, CVoucher } from "./model";

const amt = (paise: number) => (paise / 100).toFixed(2);
const qty = (milli: number) => (milli / 1000).toFixed(3);
const tallyDate = (iso: string) => iso.replace(/-/g, "");
const x = (v: string | null | undefined) => xmlEscape(v ?? "");

const UQC_NAMES: Record<string, string> = {
  BAG: "BAGS", BDL: "BUNDLES", BOX: "BOX", BTL: "BOTTLES", CAN: "CANS", CTN: "CARTONS", DOZ: "DOZENS", GMS: "GRAMMES", KGS: "KILOGRAMS",
  LTR: "LITRE", MLT: "MILILITRE", MTR: "METERS", NOS: "NUMBERS", PAC: "PACKS", PCS: "PIECES", PRS: "PAIRS", QTL: "QUINTAL", ROL: "ROLLS",
  SET: "SETS", TBS: "TABLETS", TIN: "TINS", TON: "TONNES", TUB: "TUBES", UNT: "UNITS", OTH: "OTHERS",
};

const message = (inner: string) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${inner}</TALLYMESSAGE>`;

function ledgerXml(l: CLedger): string {
  const state = l.stateCode ? gstState(l.stateCode)?.name : null;
  return message(
    `<LEDGER NAME="${x(l.name)}" ACTION="Create"><NAME.LIST><NAME>${x(l.name)}</NAME></NAME.LIST><PARENT>${x(l.group)}</PARENT>` +
      `<OPENINGBALANCE>${amt(-l.openingPaise)}</OPENINGBALANCE>` +
      (l.kind === "PARTY"
        ? `${l.gstin ? `<PARTYGSTIN>${x(l.gstin)}</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` : "<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>"}` +
          `${state ? `<LEDSTATENAME>${x(state)}</LEDSTATENAME>` : ""}${l.address ? `<ADDRESS.LIST><ADDRESS>${x(l.address)}</ADDRESS></ADDRESS.LIST>` : ""}` +
          `${l.email ? `<EMAIL>${x(l.email)}</EMAIL>` : ""}${l.phone ? `<LEDGERPHONE>${x(l.phone)}</LEDGERPHONE>` : ""}<ISBILLWISEON>Yes</ISBILLWISEON>`
        : "") +
      (l.group === "Duties & Taxes" ? `<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>${/CGST/.test(l.name) ? "Central Tax" : /SGST/.test(l.name) ? "State Tax" : /IGST/.test(l.name) ? "Integrated Tax" : "Cess"}</GSTDUTYHEAD>` : "") +
      `</LEDGER>`,
  );
}

function unitXml(u: CUnit): string {
  const uqc = u.uqc ? `${u.uqc}-${UQC_NAMES[u.uqc] ?? u.uqc}` : "";
  return message(`<UNIT NAME="${x(u.symbol)}" ACTION="Create"><NAME>${x(u.symbol)}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>${u.decimals}</DECIMALPLACES>${uqc ? `<GSTREPUOM>${x(uqc)}</GSTREPUOM>` : ""}</UNIT>`);
}

function stockItemXml(i: CStockItem): string {
  const rate = i.gstRateBp != null ? i.gstRateBp / 100 : null;
  return message(
    `<STOCKITEM NAME="${x(i.name)}" ACTION="Create"><NAME.LIST><NAME>${x(i.name)}</NAME></NAME.LIST><PARENT>${x(i.group === "Primary" ? "" : i.group)}</PARENT><BASEUNITS>${x(i.unit)}</BASEUNITS>` +
      (i.barcode ? `<MAILINGNAME.LIST><MAILINGNAME>${x(i.barcode)}</MAILINGNAME></MAILINGNAME.LIST>` : "") +
      `<GSTAPPLICABLE>${rate == null ? "Not Applicable" : "Applicable"}</GSTAPPLICABLE>` +
      (i.hsn ? `<HSNDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><HSNCODE>${x(i.hsn)}</HSNCODE></HSNDETAILS.LIST>` : "") +
      (rate != null
        ? `<GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><TAXABILITY>Taxable</TAXABILITY><STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>` +
          `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>${rate}</GSTRATE></RATEDETAILS.LIST>` +
          `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD><GSTRATE>${rate / 2}</GSTRATE></RATEDETAILS.LIST>` +
          `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD><GSTRATE>${rate / 2}</GSTRATE></RATEDETAILS.LIST>` +
          (i.cessBp ? `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>Cess</GSTRATEDUTYHEAD><GSTRATE>${i.cessBp / 100}</GSTRATE></RATEDETAILS.LIST>` : "") +
          `</STATEWISEDETAILS.LIST></GSTDETAILS.LIST>`
        : "") +
      (i.mrpPaise != null ? `<MRPDETAILS.LIST><FROMDATE>20170701</FROMDATE><MRPRATEDETAILS.LIST><STATENAME>&#4; Any</STATENAME><MRPRATE>${amt(i.mrpPaise)}</MRPRATE></MRPRATEDETAILS.LIST></MRPDETAILS.LIST>` : "") +
      (i.openingQtyMilli ? `<OPENINGBALANCE> ${qty(i.openingQtyMilli)} ${x(i.unit)}</OPENINGBALANCE>` : "") +
      `</STOCKITEM>`,
  );
}

function voucherXml(v: CVoucher): string {
  const ledgers = v.ledgerLines
    .map((l) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${x(l.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${l.amountPaise > 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${amt(-l.amountPaise)}</AMOUNT></ALLLEDGERENTRIES.LIST>`)
    .join("");
  const inventory = v.inventoryLines
    .map((i) => {
      const value = i.ratePaise != null ? Math.round((Math.abs(i.qtyMilli) * i.ratePaise) / 1000) : 0;
      const inward = i.qtyMilli > 0;
      return (
        `<INVENTORYENTRIES.LIST><STOCKITEMNAME>${x(i.item)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${inward ? "Yes" : "No"}</ISDEEMEDPOSITIVE>` +
        (i.ratePaise != null ? `<RATE>${amt(i.ratePaise)}</RATE>` : "") +
        `<AMOUNT>${amt(inward ? -value : value)}</AMOUNT><ACTUALQTY> ${qty(Math.abs(i.qtyMilli))}</ACTUALQTY><BILLEDQTY> ${qty(Math.abs(i.qtyMilli))}</BILLEDQTY>` +
        `<BATCHALLOCATIONS.LIST><GODOWNNAME>${x(i.godown)}</GODOWNNAME><AMOUNT>${amt(inward ? -value : value)}</AMOUNT><ACTUALQTY> ${qty(Math.abs(i.qtyMilli))}</ACTUALQTY><BILLEDQTY> ${qty(Math.abs(i.qtyMilli))}</BILLEDQTY></BATCHALLOCATIONS.LIST></INVENTORYENTRIES.LIST>`
      );
    })
    .join("");
  return message(
    `<VOUCHER REMOTEID="${x(v.key)}" VCHTYPE="${x(v.tallyType)}" ACTION="Create"><DATE>${tallyDate(v.date)}</DATE><VOUCHERTYPENAME>${x(v.tallyType)}</VOUCHERTYPENAME>` +
      `<VOUCHERNUMBER>${x(v.number)}</VOUCHERNUMBER><REFERENCE>${x(v.number)}</REFERENCE>${v.party ? `<PARTYLEDGERNAME>${x(v.party)}</PARTYLEDGERNAME>` : ""}` +
      `<NARRATION>${x(v.narration)}</NARRATION>${ledgers}${inventory}</VOUCHER>`,
  );
}

/** Masters then vouchers, as one file TallyPrime imports (Gateway of Tally → Import → Masters, then Transactions). */
export function toTallyXml(books: CanonicalBooks, company?: string): string {
  const name = x(company ?? books.company.legalName);
  const own = new Set(["Primary", "Sundry Debtors", "Sundry Creditors", "Duties & Taxes", "Bank Accounts", "Cash-in-Hand", "Sales Accounts", "Purchase Accounts", "Indirect Expenses", "Direct Expenses", "Capital Account", "Current Assets", "Current Liabilities", "Loans & Advances (Asset)"]);
  const groups = books.ledgerGroups
    .filter((g) => !own.has(g.name) && !g.name.includes("/"))
    .map((g) => message(`<GROUP NAME="${x(g.name)}" ACTION="Create"><NAME.LIST><NAME>${x(g.name)}</NAME></NAME.LIST><PARENT>${g.nature === "ASSET" ? "Current Assets" : g.nature === "LIABILITY" ? "Current Liabilities" : "Primary"}</PARENT></GROUP>`));
  const masters = [
    ...groups,
    ...books.ledgers.filter((l) => !(l.kind === "BOOK" && l.openingPaise === 0 && !books.vouchers.some((v) => v.ledgerLines.some((line) => line.ledger === l.name)))).map(ledgerXml),
    ...books.units.map(unitXml),
    ...books.godowns.map((g) => message(`<GODOWN NAME="${x(g.name)}" ACTION="Create"><NAME.LIST><NAME>${x(g.name)}</NAME></NAME.LIST><PARENT/></GODOWN>`)),
    ...books.stockGroups.filter((g) => g.name !== "Primary").map((g) => message(`<STOCKGROUP NAME="${x(g.name)}" ACTION="Create"><NAME.LIST><NAME>${x(g.name)}</NAME></NAME.LIST><PARENT/></STOCKGROUP>`)),
    ...books.stockItems.map(stockItemXml),
  ].join("\n");
  const vouchers = books.vouchers.filter((v) => v.ledgerLines.length || v.inventoryLines.length).map(voucherXml).join("\n");
  const section = (report: string, body: string) =>
    `<IMPORTDATA>\n<REQUESTDESC><REPORTNAME>${report}</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${name}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>\n<REQUESTDATA>\n${body}\n</REQUESTDATA>\n</IMPORTDATA>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE>\n<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>\n<BODY>\n${section("All Masters", masters)}\n${section("Vouchers", vouchers)}\n</BODY>\n</ENVELOPE>\n`;
}

/* ------------------------------------------------------------- import */

type Node = Record<string, unknown>;
const arr = (v: unknown): Node[] => (v == null ? [] : ((Array.isArray(v) ? v : [v]) as Node[]));
const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => (v == null ? "" : typeof v === "object" ? String((v as { "#text"?: unknown })["#text"] ?? "") : String(v)).trim();
const paise = (v: unknown) => Math.round(Number(text(v).replace(/[^0-9.-]/g, "") || 0) * 100);
const milli = (v: unknown) => Math.round(Number(text(v).replace(/[^0-9.-]/g, "") || 0) * 1000);
const isoDate = (v: unknown) => {
  const d = text(v);
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
};

/** Tally's XML export (masters and / or vouchers) as canonical records. Unknown tags are ignored. */
export function parseTallyXml(xml: string): Pick<CanonicalBooks, "ledgers" | "units" | "stockGroups" | "stockItems" | "vouchers"> {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false, trimValues: true, processEntities: true });
  const doc = parser.parse(xml);
  const messages: Node[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "TALLYMESSAGE") for (const m of arr(v)) messages.push(m);
      else if (typeof v === "object") for (const child of list(v)) walk(child);
    }
  };
  walk(doc);
  const ledgers: CLedger[] = [];
  const units: CUnit[] = [];
  const stockGroups: { name: string }[] = [];
  const stockItems: CStockItem[] = [];
  const vouchers: CVoucher[] = [];
  for (const m of messages) {
    for (const l of arr(m.LEDGER)) {
      const name = text(l["@NAME"]) || text((l["NAME.LIST"] as Node | undefined)?.NAME);
      if (!name) continue;
      const parent = text(l.PARENT);
      const gstin = text(l.PARTYGSTIN) || null;
      ledgers.push({
        key: `TALLY:${name}`,
        name,
        group: parent,
        kind: /Sundry (Debtors|Creditors)/i.test(parent) ? "PARTY" : "BOOK",
        gstin,
        stateCode: gstState(text(l.LEDSTATENAME) || gstin)?.code ?? null,
        address: list((l["ADDRESS.LIST"] as Node | undefined)?.ADDRESS).map(text).join(", ") || null,
        email: text(l.EMAIL) || null,
        phone: text(l.LEDGERPHONE) || null,
        openingPaise: -paise(l.OPENINGBALANCE),
      });
    }
    for (const u of arr(m.UNIT)) {
      const symbol = text(u["@NAME"]) || text(u.NAME);
      if (symbol) units.push({ symbol, uqc: text(u.GSTREPUOM).split("-")[0] || null, decimals: Number(text(u.DECIMALPLACES) || 0) });
    }
    for (const g of arr(m.STOCKGROUP)) {
      const name = text(g["@NAME"]);
      if (name) stockGroups.push({ name });
    }
    for (const s of arr(m.STOCKITEM)) {
      const name = text(s["@NAME"]) || text((s["NAME.LIST"] as Node | undefined)?.NAME);
      if (!name) continue;
      const hsn = arr(s["HSNDETAILS.LIST"]).map((h) => text(h.HSNCODE)).filter(Boolean).pop() ?? null;
      const rates = arr(s["GSTDETAILS.LIST"]).flatMap((g) => arr(g["STATEWISEDETAILS.LIST"])).flatMap((sw) => arr(sw["RATEDETAILS.LIST"]));
      const igst = rates.find((r) => /Integrated/i.test(text(r.GSTRATEDUTYHEAD)));
      const cess = rates.find((r) => /Cess/i.test(text(r.GSTRATEDUTYHEAD)));
      const opening = text(s.OPENINGBALANCE);
      const mrp = arr(s["MRPDETAILS.LIST"]).flatMap((d) => arr(d["MRPRATEDETAILS.LIST"])).map((r) => paise(r.MRPRATE)).pop();
      stockItems.push({
        key: `TALLY:${name}`,
        name,
        group: text(s.PARENT) || "Primary",
        unit: text(s.BASEUNITS) || "Nos",
        hsn,
        gstRateBp: igst ? Math.round(Number(text(igst.GSTRATE)) * 100) : null,
        cessBp: cess ? Math.round(Number(text(cess.GSTRATE)) * 100) : 0,
        mrpPaise: mrp ?? null,
        salePricePaise: null,
        barcode: null,
        openingQtyMilli: opening ? milli(opening.split(/\s+/)[0]) : 0,
      });
    }
    for (const v of arr(m.VOUCHER)) {
      const tallyType = text(v.VOUCHERTYPENAME) || text(v["@VCHTYPE"]);
      const date = isoDate(v.DATE);
      const number = text(v.VOUCHERNUMBER);
      const ledgerLines = [...arr(v["ALLLEDGERENTRIES.LIST"]), ...arr(v["LEDGERENTRIES.LIST"])].map((e) => ({ ledger: text(e.LEDGERNAME), amountPaise: -paise(e.AMOUNT) }));
      const inventoryLines = [...arr(v["ALLINVENTORYENTRIES.LIST"]), ...arr(v["INVENTORYENTRIES.LIST"])].map((e) => {
        const inward = text(e.ISDEEMEDPOSITIVE) === "Yes";
        const godown = arr(e["BATCHALLOCATIONS.LIST"]).map((b) => text(b.GODOWNNAME)).find(Boolean) ?? "";
        const q = milli(text(e.ACTUALQTY).split(/\s+/)[0] || e.ACTUALQTY);
        return { item: text(e.STOCKITEMNAME), godown, qtyMilli: inward ? q : -q, ratePaise: text(e.RATE) ? paise(text(e.RATE).split("/")[0]) : null };
      });
      vouchers.push({
        key: `${tallyType}|${date}|${number}`,
        type: tallyType,
        tallyType,
        date,
        number,
        narration: text(v.NARRATION) || null,
        party: text(v.PARTYLEDGERNAME) || null,
        ledgerLines,
        inventoryLines,
        taxLines: [],
      });
    }
  }
  return { ledgers, units, stockGroups, stockItems, vouchers };
}
