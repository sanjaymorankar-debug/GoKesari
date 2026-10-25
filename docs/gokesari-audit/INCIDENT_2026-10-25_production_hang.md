# Incident: gokesari.com stopped answering after the 25 Oct deploy

- **When:** 25 Oct 2026, from about 01:56 to 02:10 UTC (07:26–07:40 IST), about 14 minutes.
- **Impact:** every request to gokesari.com timed out, including pages, API routes and static files. test.gokesari.com was not affected.
- **Recovery:** the Node.js application was restarted through the Hostinger API (`hosting_nodejs_restart-application`) at 02:09:45 UTC. This was a restart only: no rebuild, and no change to code or data. The site answered 200 at 02:10. The guest QA tier passed afterwards (96 pass, 0 fail).

## Timeline (UTC)

| Time | Event |
|---|---|
| 01:47:02 | #248 merged into main (1ed8e09). Hostinger starts build A at 01:47:13. |
| 01:48:17 | #249 merged into main from another session (4a32386). It has the same files as 1ed8e09. Hostinger starts build B at 01:48:33, **while build A is still running**. |
| 01:51:27 | Build A publishes, switches "current" to its version and restarts the app ("restarted in 15.2 s"). |
| 01:55:19–01:55:30 | Build B publishes ("current" now B), stops "processes from the previous version" and restarts the app ("restarted in 5.5 s"). The runtime log shows three Next.js starts. |
| 01:56 | The first probe from the QA session gets a 307 answered by the host itself (the E-01 pattern). After that, every request times out. |
| 01:57:30–01:57:32 | Two more Next.js starts with no deploy behind them. Something on the host respawned the app. |
| 01:57–02:09 | No answer on any path. TLS connects, then nothing comes back. No errors in the runtime log. |
| 02:09:45 | App restarted through the API. Starts are logged at 02:09:49 and 02:09:56. |
| 02:10:09 | First 200 (13.9 s while the app warmed up). It is normal (1–3 s) after that. |

## Cause

**Most likely cause: two deployments ran at the same time.** This is not proven; see "What is not known" below.

- Build B started 80 seconds after build A (#249 was merged 75 seconds after #248). It published and restarted the app four minutes after A had switched to its own version and restarted.
- In the last 99 production builds this is the **first time two builds overlapped**. Every earlier deploy ran alone, including #242 three hours before, and all of those came up normally.
- The runtime log shows extra process starts: three at 01:55, two more at 01:57 with no deploy behind them, and only two for a normal restart (02:09). After them the front end had no working app process to send requests to.

**What rules out the code:**
- The same files (1ed8e09 = 4a32386) answered normally as soon as the app was restarted.
- They also run on test.gokesari.com.
- Both builds finished cleanly: compiled, typechecked, published, "Deployment completed".
- The migration step applied nothing (92 recorded, 0 new).
- The runtime log has no error before the outage.

**What is not known:**
- Hostinger's API exposes no process list, front-end (LiteSpeed) log or resource-usage figures for this plan.
- So it can't be shown whether the extra processes held the port, were stopped by the second deploy's "stop previous version" step, or hit the account's process or memory limit while two builds ran (each with 7 workers).
- The runtime log is reset on every deploy, so nothing from before 01:55:19 survives.

## Why two builds ran

Two sessions released the same staging code to main 75 seconds apart:
- #248 from the QA session;
- #249 "Release: staging → main … D-104, QA reports 24 Oct" from another session.

Hostinger starts a build for every push to main and does not queue or cancel overlapping builds.

## Recommendations

1. **One release at a time.** Only one session or person merges into main at a time. Wait for the deploy to complete and the site to answer before the next merge. Releases from different sessions need coordinating; for example, check for an open staging → main PR and whether the last Hostinger build has finished.
2. **Check the site after every production deploy.** After "Deployment completed", request `/` and `/shops`. If they don't answer within a minute, restart the app (`hosting_nodejs_restart-application`) and re-check. This could go in the release steps or a small workflow.
3. **Uptime monitoring.** Add an external uptime check on gokesari.com (every 1–5 minutes) with an alert to the owner. This outage was seen only because a QA run happened to be waiting for the deploy.
4. **Ask Hostinger support:**
   - whether builds triggered close together can be queued, or the older one cancelled;
   - why the app was respawned at 01:57:30 with no deploy;
   - whether the account hit a process or memory limit at 01:55–01:57.
