/**
 * RBAC v2 signed-in flows on test.gokesari.com (docs/rbac/testing-report.md, staging run).
 * Uses the saved staging sessions (.e2e-auth/staging-{admin,ops,oplim,shop}.json, from scripts/qa/signin-staging.ts):
 *   gk-ops   holds ACCOUNTANT, SUPPORT_MANAGER, OPERATIONS_MANAGER
 *   gk-oplim holds CA, SUPPORT_USER, OPERATIONS_USER
 * Each step switches the account's active role to the one it tests, prints PASS / FAIL, and at the end puts
 * gk-oplim back on OPERATOR_LIMITED. Creates only clearly marked QA data (₹1 journal, ₹1.50 bank statement,
 * one task, one ticket, one rejected change request). Staging only — refuses any other host.
 *
 *   node scripts/rbac/staging-flows.mjs [authDir]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://test.gokesari.com";
const AUTH = process.argv[2] ?? ".e2e-auth";
const SHOP_A = JSON.parse(readFileSync("tests/qa/worlds/staging.json", "utf8")).shops.A.id;
const TAG = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 19).replace(/[-:T]/g, "");
const TODAY = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const results = [];

function session(role) {
  const s = JSON.parse(readFileSync(join(AUTH, `staging-${role}.json`), "utf8"));
  return s.cookies.filter((c) => "test.gokesari.com".endsWith(c.domain.replace(/^\./, ""))).map((c) => `${c.name}=${c.value}`).join("; ");
}
const who = { admin: session("admin"), ops: session("ops"), oplim: session("oplim"), shop: session("shop") };

async function api(as, method, path, body) {
  const headers = { cookie: who[as], origin: BASE };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, data: json?.data ?? json, error: json?.error?.message, text, location: res.headers.get("location") };
}

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
}
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
  }
}
const must = (r, what) => {
  if (r.status >= 400) throw new Error(`${what}: HTTP ${r.status} ${r.error ?? r.text.slice(0, 160)}`);
  return r.data;
};
const asRole = async (as, role) => must(await api(as, "PUT", "/api/me/roles", { role }), `switch ${as} to ${role}`);
const me = async (as) => must(await api(as, "GET", "/api/me/roles"), "me");

async function main() {
  if (!BASE.includes("test.gokesari.com")) throw new Error("staging only");
  const users = must(await api("admin", "GET", "/api/users?q=gk-o"), "users");
  const ops = users.find((u) => u.email === "sanjaymorankar+gk-ops@gmail.com");
  const oplim = users.find((u) => u.email === "sanjaymorankar+gk-oplim@gmail.com");

  /* ---------------------------------------------------------------- pages */
  await step("pages", async () => {
    for (const [as, role, path] of [
      ["ops", "ACCOUNTANT", "/staff/accounting?tab=bank"],
      ["oplim", "CA", "/staff/accounting?tab=approvals"],
      ["ops", "SUPPORT_MANAGER", "/staff/support"],
      ["ops", "OPERATIONS_MANAGER", "/staff/operations"],
      ["oplim", "OPERATIONS_USER", "/staff"],
      ["admin", null, "/admin/approvals"],
      ["admin", null, "/admin/staff-teams"],
    ]) {
      if (role) await asRole(as, role);
      const r = await api(as, "GET", path);
      check(`page ${path} as ${role ?? "ADMIN"}`, r.status === 200 && !/Application error/.test(r.text), `HTTP ${r.status}${r.location ? ` → ${r.location}` : ""}`);
    }
  });

  /* ------------------------------------------------------------- accounting */
  let journalId = null;
  await step("journal Accountant → CA", async () => {
    await asRole("ops", "ACCOUNTANT");
    await asRole("oplim", "CA");
    const draft = must(
      await api("ops", "POST", "/api/staff/accounting/journals", {
        entryDate: TODAY,
        narration: `QA ${TAG} test receipt (staging)`,
        lines: [
          { accountCode: "1010", accountName: "QA bank", debitPaise: 100 },
          { accountCode: "4990", accountName: "QA income", creditPaise: 100 },
        ],
      }),
      "draft",
    );
    const sub = must(await api("ops", "POST", `/api/staff/accounting/journals/${draft.id}/submit`), "submit");
    const self = await api("ops", "POST", `/api/approvals/${sub.approvalRequestId}/decide`, { decision: "APPROVE" });
    check("Accountant cannot approve own journal", self.status === 403, `HTTP ${self.status}`);
    must(await api("oplim", "POST", `/api/approvals/${sub.approvalRequestId}/decide`, { decision: "APPROVE" }), "CA approve");
    const after = must(await api("ops", "GET", `/api/staff/accounting/journals/${draft.id}`), "read");
    journalId = draft.id;
    check("journal posted by the CA", (after.entry ?? after).status === "POSTED", (after.entry ?? after).status);
  });

  await step("bank reconciliation", async () => {
    const csv = [
      "Date,Narration,Ref No,Debit,Credit,Balance",
      "Opening Balance,,,,,1000.00",
      `${TODAY.split("-").reverse().join("/")},QA ${TAG} RECEIPT,QA${TAG},,1.00,1001.00`,
      `${TODAY.split("-").reverse().join("/")},QA ${TAG} SMS CHARGES,,0.50,,1000.50`,
    ].join("\n");
    const form = () => {
      const f = new FormData();
      f.set("file", new Blob([csv], { type: "text/csv" }), `qa-${TAG}.csv`);
      f.set("accountLabel", `QA run ${Number(TAG).toString(36)} ••0000`); // no 7-digit runs in a label; unique per run (period overlap rule)
      return f;
    };
    const caTry = await api("oplim", "POST", "/api/staff/accounting/bank-statements", form());
    check("CA cannot import a statement", caTry.status === 403, `HTTP ${caTry.status}`);
    const preview = new FormData();
    preview.set("file", new Blob([csv], { type: "text/csv" }), `qa-${TAG}.csv`);
    preview.set("preview", "1");
    const pv = must(await api("ops", "POST", "/api/staff/accounting/bank-statements", preview), "preview");
    check("preview reads 2 lines, no problems", pv.lineCount === 2 && pv.errors.length === 0, `${pv.lineCount} lines, ${pv.errors.length} errors`);
    const imp = must(await api("ops", "POST", "/api/staff/accounting/bank-statements", form()), "import");
    const again = await api("ops", "POST", "/api/staff/accounting/bank-statements", form());
    check("same file twice refused", again.status === 409, `HTTP ${again.status}`);
    const sid = imp.statement.id;
    const view = must(await api("ops", "GET", `/api/staff/accounting/bank-statements/${sid}`), "view");
    const [credit, debit] = view.lines;
    must(await api("ops", "POST", `/api/staff/accounting/bank-lines/${credit.id}`, { action: "match", kind: "JOURNAL", id: journalId }), "match credit");
    must(await api("ops", "POST", `/api/staff/accounting/bank-lines/${debit.id}`, { action: "exclude", reason: "QA bank SMS charges" }), "exclude debit");
    const sub = must(await api("ops", "POST", `/api/staff/accounting/bank-statements/${sid}/submit`), "submit");
    must(await api("oplim", "POST", `/api/approvals/${sub.approvalRequestId}/decide`, { decision: "APPROVE" }), "CA sign-off");
    const done = must(await api("oplim", "GET", `/api/staff/accounting/bank-statements/${sid}`), "read");
    check("statement reconciled by the CA", done.statement.status === "RECONCILED", `${imp.statement.statementNumber} ${done.statement.status}`);
    const csvOut = await api("oplim", "GET", `/api/staff/accounting/bank-statements/${sid}?format=csv`);
    check("reconciliation CSV downloads", csvOut.status === 200 && csvOut.text.startsWith("line,date"), `HTTP ${csvOut.status}`);
    const del = await api("ops", "DELETE", `/api/staff/accounting/bank-statements/${sid}`);
    check("reconciled statement cannot be deleted", del.status === 409, `HTTP ${del.status}`);
  });

  /* -------------------------------------------------- operations → support */
  let taskId = null;
  let ticketId = null;
  await step("operations task", async () => {
    for (const team of ["OPERATIONS", "SUPPORT"]) {
      const r = await api("admin", "POST", "/api/staff/teams", { team, managerUserId: ops.id, memberUserId: oplim.id });
      if (r.status >= 400 && r.status !== 409 && !/already/i.test(r.error ?? "")) throw new Error(`team ${team}: ${r.status} ${r.error}`);
    }
    await asRole("ops", "OPERATIONS_MANAGER");
    await asRole("oplim", "OPERATIONS_USER");
    const task = must(
      await api("ops", "POST", "/api/staff/operations/tasks", { kind: "FOLLOW_UP", title: `QA ${TAG} follow up with the shop`, assigneeUserId: oplim.id, shopId: SHOP_A }),
      "create task",
    );
    taskId = task.id;
    const mine = must(await api("oplim", "GET", "/api/staff/operations/tasks"), "list");
    check("Operations User sees the assigned task", (mine.tasks ?? mine).some((t) => t.id === taskId));
    must(await api("oplim", "PATCH", `/api/staff/operations/tasks/${taskId}`, { action: "START" }), "start");
  });

  await step("handover to support", async () => {
    const t = must(
      await api("oplim", "POST", "/api/staff/support/tickets", {
        shopId: SHOP_A,
        category: "SHOP_VERIFICATION",
        subject: `QA ${TAG} shop description needs a fix`,
        description: "QA staging test: the shop owner asked to update the shop description.",
        opsTaskId: taskId,
      }),
      "raise ticket",
    );
    ticketId = t.id;
    check("Operations User raised a ticket linked to the task", !!ticketId);
    await asRole("ops", "SUPPORT_MANAGER");
    must(await api("ops", "PATCH", `/api/staff/support/tickets/${ticketId}`, { assigneeId: oplim.id, priority: "NORMAL", note: "QA assign" }), "assign");
    await asRole("oplim", "SUPPORT_USER");
    const mine = must(await api("oplim", "GET", "/api/staff/support/tickets?view=mine"), "mine");
    check("Support User sees the assigned ticket", (mine.tickets ?? mine).some((x) => x.id === ticketId));
    const cr = must(
      await api("oplim", "POST", `/api/staff/shops/${SHOP_A}/changes`, {
        ticketId,
        reason: `QA ${TAG}: description change for the owner to decide`,
        items: [{ target: "SHOP", field: "description", value: `QA ${TAG} proposed description (to be rejected)` }],
      }),
      "propose",
    );
    const requestId = cr.request?.id ?? cr.id;
    const shopReject = await api("shop", "POST", `/api/approvals/${requestId}/decide`, { decision: "REJECT", comment: "QA: keep the current description" });
    check("shop owner rejects the proposed change", shopReject.status < 400, `HTTP ${shopReject.status} ${shopReject.error ?? ""}`);
    await asRole("oplim", "OPERATIONS_USER");
    must(await api("oplim", "PATCH", `/api/staff/operations/tasks/${taskId}`, { action: "DONE", outcome: "QA: handed to support, owner decided" }), "task done");
    check("Operations task closed", true);
  });

  /* ---------------------------------------------------------------- tidy up */
  await step("restore gk-oplim", async () => {
    await asRole("oplim", "OPERATOR_LIMITED");
    check("gk-oplim back on OPERATOR_LIMITED", (await me("oplim")).active === "OPERATOR_LIMITED");
  });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed (run ${TAG} IST)`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
