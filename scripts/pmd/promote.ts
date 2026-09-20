/**
 * Bulk promotion: puts eligible master products into the marketplace catalogue (public.products), through the
 * same audited, one-transaction-per-product bridge the API uses. DRY RUN unless --apply is given.
 *
 * Promoted products are APPROVED at once, so shops can pick them the moment this runs. Read the dry run first.
 *
 *   PMD_DATABASE_URL=<target> [PMD_ALLOW_REMOTE=1] npx tsx scripts/pmd/promote.ts
 *       [--min-quality 60] [--department DAIRY,SUPERMARKET] [--limit 500] [--no-images]
 *       [--actor-email <operator or admin>] [--note "text"] [--apply]
 *
 * --actor-email is required with --apply: the user the audit trail records. It must be an ACTIVE OPERATOR or ADMIN.
 */
import { promoteToCatalogue, PromotionError } from "@/server/pmd/services/catalogue-bridge";
import { arg, connect, describeTarget, flag, pmdDatabaseUrl } from "./lib";

interface Candidate {
  master_product_id: string;
  product_name: string;
  brand_name: string | null;
  department: string;
  data_quality_score: number;
  has_image: boolean;
  /** An existing catalogue product has this GTIN (any written form): promotion links to it instead of creating one. */
  would_adopt: boolean;
}

async function main() {
  console.log(`target   ${describeTarget(pmdDatabaseUrl())}`);
  const sql = connect();
  const apply = flag("apply");
  const minQuality = Number(arg("min-quality", "60"));
  const departments = (arg("department") ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  const limit = Number(arg("limit", "100000"));
  const images = !flag("no-images");
  const note = arg("note", "Bulk promotion from the open-data pilot") ?? null;

  const candidates = await sql<Candidate[]>`
    SELECT m.master_product_id, m.product_name, b.brand_name, c.gokesari_department AS department, m.data_quality_score::float8 AS data_quality_score,
           EXISTS (SELECT 1 FROM pmd.product_image i WHERE i.product_id = m.product_id) AS has_image,
           m.gtin IS NOT NULL AND EXISTS (
             SELECT 1 FROM public.products p WHERE p.deleted_at IS NULL AND p.gtin IS NOT NULL AND p.gtin IN (
               m.gtin, CASE WHEN m.gtin LIKE '0%' THEN substr(m.gtin, 2) END, CASE WHEN m.gtin LIKE '00%' THEN substr(m.gtin, 3) END)) AS would_adopt
    FROM pmd.product_master m
    JOIN pmd.category c ON c.category_id = m.category_id
    LEFT JOIN pmd.brand b ON b.brand_id = m.brand_id
    WHERE m.record_status = 'ACTIVE' AND c.gokesari_department IS NOT NULL AND m.data_quality_score >= ${minQuality}
      AND (${departments.length === 0} OR c.gokesari_department = ANY(${departments}::text[]))
      AND NOT EXISTS (SELECT 1 FROM pmd.catalogue_link l WHERE l.product_id = m.product_id)
    ORDER BY m.data_quality_score DESC, m.product_id
    LIMIT ${limit}`;

  const byDept = new Map<string, number>();
  for (const c of candidates) byDept.set(c.department, (byDept.get(c.department) ?? 0) + 1);
  console.log(`eligible ${candidates.length} products (quality >= ${minQuality}${departments.length ? `, departments ${departments.join("/")}` : ""}), images ${images ? "linked" : "NOT linked"}`);
  for (const [d, n] of [...byDept].sort((a, b) => b[1] - a[1])) console.log(`  ${d.padEnd(24)} ${n}`);
  console.log(`  with an image: ${candidates.filter((c) => c.has_image).length}`);
  const adopting = candidates.filter((c) => c.would_adopt).length;
  console.log(`  would ADOPT an existing catalogue product (same GTIN, nothing created or changed there): ${adopting}; would CREATE: ${candidates.length - adopting}`);
  // The bridge needs a marketplace category in the same department; without one it refuses the product.
  const stocked = new Set((await sql<{ department: string }[]>`SELECT DISTINCT department::text AS department FROM public.product_categories WHERE deleted_at IS NULL`).map((r) => r.department));
  const missing = [...byDept].filter(([d]) => !stocked.has(d));
  if (missing.length) {
    console.log(`  WARNING: no marketplace category exists for ${missing.map(([d, n]) => `${d} (${n})`).join(", ")} - those would be refused (NO_OPERATIONAL_CATEGORY). Create the categories first.`);
  }
  for (const c of candidates.slice(0, 8)) console.log(`  e.g. ${c.master_product_id}  ${c.department.padEnd(18)} ${String(c.data_quality_score).padStart(5)}  ${c.brand_name ?? "-"} | ${c.product_name}`);

  if (!apply) {
    console.log("\nDRY RUN - nothing written. Re-run with --apply --actor-email <user> to promote.");
    await sql.end();
    return;
  }

  const email = arg("actor-email");
  if (!email) throw new Error("--apply needs --actor-email <an ACTIVE OPERATOR or ADMIN of the target application>.");
  const [actor] = await sql<{ id: string; role: string }[]>`
    SELECT id, role::text AS role FROM public.users WHERE lower(email) = lower(${email}) AND status = 'ACTIVE' AND deleted_at IS NULL AND role IN ('OPERATOR','ADMIN') LIMIT 1`;
  if (!actor) throw new Error("No ACTIVE OPERATOR/ADMIN with that email exists in the target database.");

  const outcome = { promoted: 0, adopted: 0, failed: new Map<string, number>() };
  for (const [i, c] of candidates.entries()) {
    try {
      const r = await promoteToCatalogue(sql, c.master_product_id, { userId: actor.id, role: actor.role }, { minQuality, note, images });
      if (r.adopted) outcome.adopted++;
      else outcome.promoted++;
    } catch (e) {
      const code = e instanceof PromotionError ? e.code : "ERROR";
      outcome.failed.set(code, (outcome.failed.get(code) ?? 0) + 1);
      if (!(e instanceof PromotionError)) console.error(`  ${c.master_product_id}: ${(e as Error).message}`);
    }
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${candidates.length}`);
  }
  console.log(`\npromoted ${outcome.promoted}, adopted an existing catalogue row ${outcome.adopted}, refused ${[...outcome.failed.values()].reduce((a, b) => a + b, 0)}`);
  for (const [code, n] of outcome.failed) console.log(`  ${code}: ${n}`);
  await sql.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
