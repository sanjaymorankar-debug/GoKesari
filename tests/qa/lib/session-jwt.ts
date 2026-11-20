/**
 * Signs a session cookie value the way Auth.js does, for the QA suite's signed-in actors.
 *
 * next-auth/jwt is an ES module. The suite's files are compiled to CommonJS, so a static
 * `import { encode } from "next-auth/jwt"` becomes a require() of that ES module, and Node
 * refuses it when another file is import()-ing the same module at that moment ("Cannot
 * require() ES Module … because it is not yet fully loaded"; staging queue #424, PR #422's
 * guest run). Loading it with import() everywhere, through this one helper, removes the race.
 */
import type { JWTEncodeParams } from "next-auth/jwt";

export async function encodeSession(params: JWTEncodeParams): Promise<string> {
  const { encode } = await import("next-auth/jwt");
  return encode(params);
}
