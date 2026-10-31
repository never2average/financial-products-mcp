---
name: financial-modelling
description: What a good feasibility model covers for each product line (credit, deposits, wealth, insurance, treasury), with stress scenarios and regulatory checks.
---

# What a good model covers

Always include:
- **Stress scenarios:** e.g. the default rate doubled, rates moved ±200bp, faster prepayment, a lapse shock,
  falling AUM.
- **A check per applicable regulatory limit**, citing its `legal_ref` from the spec. If the limit's number isn't
  in the spec, say so in the check; never invent it.
- **Stated assumptions:** every assumption, with where it came from (the term sheet, an industry benchmark you
  name, or your judgement, flagged as such).

| Line | Cover |
|---|---|
| **Credit** | Pricing build-up: cost of funds, expected loss (PD × LGD), operating costs, capital charge (risk weight × capital ratio × cost of equity), margin. APR including fees, and EMI. Return on risk-adjusted capital (RAROC). Cohort cash flows and breakeven. |
| **Deposits** | Margin against where the money is deployed. Liquidity ladder by tenor. Reserve-requirement drag (CRR/SLR, where it applies). Deposit-insurance premium. The cost of the early-withdrawal penalty. |
| **Wealth** | Fee income against expense-ratio (TER) and commission caps. Distribution trail. The AUM at which the product breaks even, and the time to reach it. |
| **Insurance** | Expected claims (frequency × severity, or mortality/morbidity tables you name). Loss ratio and combined ratio. Commission caps. Reserving, and the solvency margin. |
| **Treasury** | Spread, duration and convexity, and how the value moves when rates move. Liquidity and counterparty limits. |
