import { Card, LinkButton } from "@/components/ui";

export function ResultSummary({
  live,
  needs,
  outOfStock,
  needsHref,
  productsHref,
}: {
  live: number;
  needs: number;
  outOfStock: number;
  needsHref: string;
  productsHref: string;
}) {
  return (
    <Card className="space-y-3 p-5" data-testid="setup-result" role="status">
      <p className="text-lg font-semibold text-ink-900">
        {live} live, {needs} need stock or price
      </p>
      {outOfStock > 0 ? <p className="text-sm text-ink-500">{outOfStock} out of stock.</p> : null}
      <div className="flex flex-wrap gap-2">
        <LinkButton href={needsHref}>Update stock now</LinkButton>
        <LinkButton href={productsHref} variant="secondary">
          Go to my products
        </LinkButton>
      </div>
    </Card>
  );
}
