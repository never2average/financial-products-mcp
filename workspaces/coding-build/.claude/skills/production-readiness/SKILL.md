---
name: production-readiness
description: The production-readiness checklist every Mynt build must pass before pushing — the build's checking phase.
---

# Production readiness

Each item passes or fails. Mynt re-runs the checks it can (tests, secrets scan, dependency audit, SBOM,
disclosures) in a clean sandbox, so make them pass for real.

| Item | Passes when |
|---|---|
| `tests` | All tests pass. |
| `lint_typecheck` | The linter and type checker report no errors. |
| `secrets_scan` | There are no secrets in the tree or the git history. |
| `dependency_audit` | There are no high or critical advisories in production dependencies. |
| `sbom` | A CycloneDX SBOM is generated and committed (e.g. `sbom.cdx.json`). |
| `disclosures` | Every required disclosure appears verbatim wherever its product does. |
| `permitted_actions` | Only the actions each product's build terms permit are used. |
| `no_financial_data` | The app collects no money, KYC or financial data. |
| `docs` | A README explains how to run, test and deploy. |

Record each result in `job/result.json` under `readiness`.
