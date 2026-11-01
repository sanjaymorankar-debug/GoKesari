/**
 * Tax out of a tax-inclusive amount (NEW-007 maths), shared by the invoice
 * module (services/invoices.ts re-exports these) and the tax engine.
 */

/** Tax out of a tax-inclusive amount. */
export function splitInclusive(grossPaise: number, rateBp: number, supply: "INTRA" | "INTER") {
  const taxable = rateBp > 0 ? Math.round((grossPaise * 10_000) / (10_000 + rateBp)) : grossPaise;
  const tax = grossPaise - taxable;
  if (supply === "INTER") return { taxablePaise: taxable, cgstPaise: 0, sgstPaise: 0, igstPaise: tax };
  const cgst = Math.floor(tax / 2);
  return { taxablePaise: taxable, cgstPaise: cgst, sgstPaise: tax - cgst, igstPaise: 0 };
}

/**
 * Tax out of a tax-inclusive amount that also carries an ad-valorem cess:
 * taxable = round(gross × 10000 / (10000 + rate + cess)); cess = round(taxable
 * × cess rate); GST = the rest. With no cess this is exactly splitInclusive.
 */
export function splitInclusiveWithCess(grossPaise: number, rateBp: number, cessBp: number, supply: "INTRA" | "INTER") {
  if (cessBp <= 0) return { ...splitInclusive(grossPaise, rateBp, supply), cessPaise: 0 };
  const taxable = Math.round((grossPaise * 10_000) / (10_000 + rateBp + cessBp));
  // Never more than the tax part of the price (tiny amounts at a high cess would otherwise leave GST at −1 paisa).
  const cess = rateBp > 0 ? Math.min(Math.round((taxable * cessBp) / 10_000), grossPaise - taxable) : grossPaise - taxable;
  const tax = grossPaise - taxable - cess;
  if (supply === "INTER") return { taxablePaise: taxable, cgstPaise: 0, sgstPaise: 0, igstPaise: tax, cessPaise: cess };
  const cgst = Math.floor(tax / 2);
  return { taxablePaise: taxable, cgstPaise: cgst, sgstPaise: tax - cgst, igstPaise: 0, cessPaise: cess };
}
