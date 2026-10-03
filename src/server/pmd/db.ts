/**
 * MySQL access for the product-master platform.
 *
 * The pipeline is set-based and batch-oriented - bulk upserts, candidate
 * retrieval, aggregate reports - which is what SQL is for, so it talks to the
 * driver directly rather than through an ORM row-at-a-time. The application's
 * Drizzle client is used only by the app's own services.
 *
 * PMD lives in its own MySQL database, `pmd`, on the same server as the
 * application. PostgreSQL had it as a *schema* inside the application's
 * database; MySQL has no schema-within-a-database, but `database.table` is the
 * same two-part name, so a database called `pmd` leaves all 196 `pmd.<table>`
 * references working verbatim. It has to be the same *server* because
 * pmd.catalogue_link carries foreign keys into the application's `products`
 * and `users`, which MySQL permits across databases but not across servers.
 *
 * The `sql` tag is not mysql2's API. It is the postgres.js-shaped tag in
 * ./mysql/sql.ts, which exists so PMD's 232 tagged templates - and the
 * fragment nesting they rely on - keep working unchanged. Type handling is
 * pinned there to match what this module pinned on postgres.js, so callers
 * see the same JavaScript values they saw on PostgreSQL:
 *   bigint  -> number   (ids and integer minor units are far inside 2^53)
 *   decimal -> number   (scores and canonical quantities; money is bigint)
 *   date    -> string   'YYYY-MM-DD', so a date never shifts with the timezone
 */
import { createSql as createMysqlSql, type PmdSql } from "./mysql/sql";

/**
 * The three names postgres.js distinguished. It separated them because its
 * `TransactionSql` cannot open a new top-level transaction, and PMD's
 * signatures used that to say which functions must be given a transaction.
 * The shim has no such split - `begin` hands back the same callable - so all
 * three alias one type here, and the 96 annotations across the layer keep
 * their documentary value without needing to change.
 */
export type Sql = PmdSql;
export type TransactionSql = PmdSql;
/** Either the pool or a transaction: what repository functions accept. */
export type Queryable = PmdSql;

/** What may be handed to `sql.json(...)`. */
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

export { createMysqlSql as createSql };

const globalForPmd = globalThis as unknown as { __pmdSql?: Sql };

/**
 * The connection URL for PMD. `PMD_DATABASE_URL` is honoured for the case where
 * PMD is pointed somewhere else on purpose (a read replica, different
 * credentials, a larger pool), and otherwise it is the application's own URL,
 * because the two now share a server. `npm run pmd:migrate` resolves it the
 * same way.
 */
function pmdUrl(): string {
  const url = process.env.PMD_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "neither PMD_DATABASE_URL nor DATABASE_URL is set; the product-master " +
        "layer needs a MySQL connection string (see docs/MYSQL_REQUIREMENTS.md section 5).",
    );
  }
  // Handing a postgres:// URL to mysql2 fails at the wire protocol with nothing
  // that names the real cause, so it is reported here instead.
  if (/^postgres(ql)?:/i.test(url)) {
    throw new Error(
      "the PMD connection URL is PostgreSQL. PMD has been ported to MySQL; point it " +
        "at the MySQL server holding the application database, and apply the schema " +
        "with `npm run pmd:migrate`.",
    );
  }
  return url;
}

/**
 * The application's own PMD connection (API routes, dashboard), reused across
 * dev hot reloads.
 */
export function appSql(): Sql {
  globalForPmd.__pmdSql ??= createMysqlSql(pmdUrl(), { max: 5, applicationName: "gokesari-pmd-app" });
  return globalForPmd.__pmdSql;
}
