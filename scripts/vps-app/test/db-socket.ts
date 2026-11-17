// The app's own database code against a throwaway PostgreSQL (test/db-socket.sh), with the
// environment that `gk-site env db` writes (socket form). Run by db-socket.sh.
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { db, resolveSsl } from "@/server/db";
import { appSql } from "@/server/pmd/db";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  console.log("DATABASE_URL form:", url.replace(/:[^:@/]*@/, ":***@"));
  console.log("resolveSsl(DATABASE_URL) =", resolveSsl(url));

  const rows = await db.execute(
    sql`select current_user as role, current_database() as db, inet_server_addr() is null as via_socket,
               (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as ssl`,
  );
  console.log("drizzle client (src/server/db):", JSON.stringify(rows[0] ?? rows));

  const pmd = await appSql();
  const [r] = await pmd`select current_user as role, current_database() as db, inet_server_addr() is null as via_socket`;
  console.log("pmd client (src/server/pmd/db appSql):", JSON.stringify(r));

  // The form first suggested for the kit: socket and port as URL query settings.
  const bad = postgres(`postgresql://${process.env.PGUSER}:${encodeURIComponent(process.env.PGPASSWORD ?? "")}@localhost/${r.db}?host=${process.env.PGHOST}&port=${process.env.PGPORT}`, { max: 1, connect_timeout: 5 });
  console.log("query-string form parsed as: host", JSON.stringify(bad.options.host), "port", JSON.stringify(bad.options.port), "startup settings", JSON.stringify(bad.options.connection));
  await bad.end();
  // What the server says to those startup settings, sent over the working socket:
  const probe = postgres({ path: `${process.env.PGHOST}/.s.PGSQL.${process.env.PGPORT}`, database: r.db, username: process.env.PGUSER, password: process.env.PGPASSWORD, max: 1, connection: { host: process.env.PGHOST ?? "", port: process.env.PGPORT ?? "" } });
  try {
    await probe`select 1`;
    console.log("server accepted host=/port= startup settings (unexpected)");
  } catch (e) {
    console.log("server refuses host=/port= startup settings:", (e as Error).message);
  }
  await probe.end();

  const wrong = postgres("postgresql:///" + r.db, { password: "wrong-password", max: 1 });
  try {
    await wrong`select 1`;
    console.log("wrong password accepted (unexpected)");
  } catch (e) {
    console.log("wrong password refused:", (e as Error).message);
  }
  await wrong.end();
  await pmd.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
