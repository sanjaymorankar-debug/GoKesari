import { SELLER_UNDERTAKING_CLAUSES } from "@/lib/legal/seller-undertaking";

/** The undertaking's numbered clauses (docs/seller-undertaking-2026-11): the gate, registration and the Seller Terms page. */
export function SellerUndertakingClauses({ className }: { className?: string }) {
  return (
    <ol className={className ?? "list-decimal space-y-2 pl-5"} data-testid="seller-undertaking-clauses">
      {SELLER_UNDERTAKING_CLAUSES.map((clause) => (
        <li key={clause.heading}>
          <strong>{clause.heading}.</strong> {clause.text}
        </li>
      ))}
    </ol>
  );
}
