// Local only: signs session cookies for seeded accounts the way Auth.js does (tests/qa/lib/actors.ts).
import { encode } from "next-auth/jwt";
import { writeFileSync } from "node:fs";
const [base, dir, ...pairs] = process.argv.slice(2); // pairs: role=id:email
const salt = "authjs.session-token";
for (const p of pairs) {
  const [role, rest] = p.split("=");
  const [id, email] = rest.split(":");
  const value = await encode({ token: { sub: id, email, name: role }, secret: "local-dev-secret", salt });
  writeFileSync(`${dir}/staging-${role}.json`, JSON.stringify({ cookies: [{ name: salt, value, domain: new URL(base).hostname, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
  console.log("minted", role);
}
