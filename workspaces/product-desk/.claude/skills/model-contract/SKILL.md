---
name: model-contract
description: The contract every product-desk model must follow so Mynt's runner can find, run and check it (models/<name>/model.json, MYNT_INPUT/MYNT_OUTPUT, report shape, tests).
---

# The model contract

Each model lives in `models/<name>/` in the firm's repository.

**`model.json`**
```json
{ "name": "consumer-loan-pricing", "description": "...",
  "applies_to": { "product_lines": ["credit"], "categories": ["personal-loans"] },
  "inputs": [{ "key": "apr_pct", "required": true, "unit": "%", "description": "..." }],
  "run": "python3 main.py",
  "requirements": "requirements.txt" }
```
- `applies_to` can name lines and/or categories. A model that names a category wins over one that names only the
  line.
- Input keys are lower snake case, matching the term sheet's `inputs`.

**The code**
- It reads the JSON at `$MYNT_INPUT`: `{ product, inputs, assumptions, regulatory }`.
- It writes `$MYNT_OUTPUT`:
  ```json
  { "verdict": "feasible | marginal | infeasible", "summary": "...",
    "metrics": { "net_margin_pct": 4.6 },
    "checks": [{ "name": "rate_cap", "status": "pass | warn | fail", "detail": "...", "legal_ref": "..." }],
    "scenarios": [{ "name": "pd_x2", "metrics": { "net_margin_pct": 2.2 } }],
    "assumptions": { "...": "..." } }
  ```
- Mynt rejects a report without a valid verdict, summary, metrics and checks.

**Tests:** `pytest` tests for the core calculations, in `models/<name>/tests/`.

**Verdicts:**
- `feasible`: holds under the stress scenarios.
- `marginal`: positive in the base case, but not under stress.
- `infeasible`: doesn't work even in the base case, or breaches a regulatory limit.
