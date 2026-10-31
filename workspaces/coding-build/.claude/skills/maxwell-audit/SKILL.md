---
name: maxwell-audit
description: Run Maxwell's static security workflows on the app headlessly and fix critical/high findings — the build's auditing phase.
---

# Security audit with Maxwell

1. `git clone <build.maxwell_repo> ~/maxwell`, then in `~/maxwell`: `npm ci && npm run validate`.
2. Register a company "mynt-build" and an application whose source is `~/workspace/app`, with this machine as
   the scan executor.
3. Run only its static workflows, headless:
   - `execute-scr`, `probe-cicd-env`, `probe-agent-graph` and `probe-schemas`;
   - `probe-iac` and `probe-app-chart` too, if the app has infrastructure code or charts.
4. Do not connect any external service or sign in anywhere. If a workflow asks for a login or credential, skip
   that step and note it.
5. Fix every critical and high finding and re-run, until none remain or you can't fix them.
6. Record the final counts by severity, and the findings, for `job/result.json`.

Mynt runs its own audit afterwards in a clean sandbox, so a finding you leave unfixed will block the build.
