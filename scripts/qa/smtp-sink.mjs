/**
 * A local mail catcher for QA runs: a minimal SMTP server that accepts every
 * message and writes it to <dir>/<timestamp>-<to>.eml, so local-tier cases can
 * read the sign-in codes a person would read in their mailbox.
 *
 *   node scripts/qa/smtp-sink.mjs [port=2525] [dir=test-results/qa/mail]
 *
 * Point the local server at it with AUTH_EMAIL_FROM=qa@gokesari.local and
 * AUTH_EMAIL_SERVER=smtp://localhost:2525. Local use only: it listens on
 * 127.0.0.1 and has no authentication.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 2525);
const dir = process.argv[3] ?? "test-results/qa/mail";
mkdirSync(dir, { recursive: true });

createServer((socket) => {
  let buffer = "";
  let inData = false;
  let data = "";
  let to = [];
  const reply = (line) => socket.write(`${line}\r\n`);
  reply("220 gokesari-qa-sink ESMTP");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (inData) {
        if (line === ".") {
          inData = false;
          const name = `${Date.now()}-${(to[0] ?? "unknown").replace(/[^a-z0-9@.+-]/gi, "_")}.eml`;
          writeFileSync(join(dir, name), data);
          data = "";
          to = [];
          reply("250 OK: queued");
        } else {
          data += (line.startsWith("..") ? line.slice(1) : line) + "\n";
        }
        continue;
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === "EHLO" || verb === "HELO") reply("250 gokesari-qa-sink");
      else if (verb === "MAIL") reply("250 OK");
      else if (verb === "RCPT") {
        to.push(line.replace(/^RCPT TO:\s*<?([^>]*)>?.*$/i, "$1").toLowerCase());
        reply("250 OK");
      } else if (verb === "DATA") {
        inData = true;
        reply("354 End data with <CR><LF>.<CR><LF>");
      } else if (verb === "QUIT") {
        reply("221 Bye");
        socket.end();
      } else if (verb === "RSET" || verb === "NOOP") reply("250 OK");
      else reply("250 OK");
    }
  });
  socket.on("error", () => {});
}).listen(port, "127.0.0.1", () => console.log(`smtp-sink: listening on 127.0.0.1:${port}, writing to ${dir}`));
