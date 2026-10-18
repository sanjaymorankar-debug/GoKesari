#!/usr/bin/env bash
# Production-database workflow preflight (F14.2.1 / PLT-009). Runs before the
# guard and says, for each secret and variable the run needs, whether this
# run can SEE it — never the value. When something is missing it prints the
# checklist of the usual causes, so an empty PROD_DATABASE_URL is diagnosed
# from the run log alone:
#   (a) stored as an Environment secret, but the job had no `environment:`
#       (fixed: the job now declares `environment: production`);
#   (b) stored as a Variable (vars.) instead of a Secret (secrets.), or the reverse;
#   (c) the name differs (case, spelling, a trailing space);
#   (d) a called / reusable workflow without `secrets: inherit` (not the case here);
#   (e) a run from a fork, Dependabot or a fork pull_request (secrets withheld);
#   (f) an organisation secret the repository has not been given access to;
#   (g) the `production` environment's deployment-branch rule excludes main.
set -euo pipefail

state() { if [ -n "${!1:-}" ]; then echo "set"; else echo "EMPTY"; fi; }

missing=0
{
  echo "### Preflight — what this run can see (values never printed)"
  echo "Event \`${GITHUB_EVENT_NAME:-?}\` · ref \`${GITHUB_REF:-?}\` · actor \`${GITHUB_ACTOR:-?}\` · environment \`${RUN_ENVIRONMENT:-none}\`"
  echo
  echo "| Name | Kind | Visible |"
  echo "|---|---|---|"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

check() {
  local name="$1" kind="$2" var="$3" s
  s=$(state "$var")
  echo "| \`$name\` | $kind | $s |" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  [ "$s" = "set" ] || missing=$((missing + 1))
}
check PROD_DATABASE_URL secret PROD_DATABASE_URL
check PROD_DATABASE_HOST variable EXPECTED_HOST
check PROD_DATABASE_NAME variable EXPECTED_DB
if [ "${ACTION:-}" = "migrate" ]; then check TEST_DATABASE_URL secret TEST_DATABASE_URL; fi

# A Variable holding the URL instead of the Secret — case (b) — is visible here as vars.
if [ -z "${PROD_DATABASE_URL:-}" ] && [ -n "${PROD_DATABASE_URL_AS_VAR:-}" ]; then
  echo "::error::PROD_DATABASE_URL exists as a Variable (vars.PROD_DATABASE_URL), not a Secret. Move it to Secrets and delete the variable — a variable is printed in logs."
fi

if [ "$missing" -gt 0 ]; then
  cat <<MSG | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

**$missing required value(s) are not visible to this run.** Check, in order:
1. Settings → Environments → **production**: the secret \`PROD_DATABASE_URL\` and the variables \`PROD_DATABASE_HOST\`, \`PROD_DATABASE_NAME\` (and \`TEST_DATABASE_HOST\`) are there — or at repository level (Settings → Secrets and variables → Actions). Environment values override repository values.
2. Each is the right kind: the URL under **Secrets**, host and name under **Variables**.
3. The names match exactly — upper case, no spaces.
4. Environments → production → Deployment branches: \`main\` is allowed.
5. The run was started by hand on \`main\` by a person (not a fork, not Dependabot).
6. An organisation-level secret is shared with this repository.
MSG
  echo "::error::Stopped before touching production: $missing required secret/variable value(s) are empty (see the checklist in the run summary)."
  exit 1
fi
echo "All required values are visible."
