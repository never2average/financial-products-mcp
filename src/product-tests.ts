import { createHash } from "node:crypto";
import { HORIZONS, LIQUIDITY, PRODUCT_LINES, RETURN_TYPES, RISK_LEVELS, type FinancialProduct } from "./catalog.js";

export type CheckStatus = "pass" | "warn" | "fail";
export interface Check {
  name: string;
  status: CheckStatus;
  message: string;
}
export interface TestReport {
  passed: boolean;
  fingerprint: string;
  ran_at: string;
  checks: Check[];
}

// Publishing requires a passing report whose fingerprint matches the current product data,
// so any edit after testing forces a re-test.
export function fingerprint(p: FinancialProduct): string {
  const fields = [p.id, p.name, p.product_line, p.category, p.region, p.risk_level, p.liquidity, p.typical_horizon, p.return_type, p.regulator, p.description, p.key_features];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

const check = (name: string, ok: boolean, pass: string, fail: string, failStatus: CheckStatus = "fail"): Check =>
  ok ? { name, status: "pass", message: pass } : { name, status: failStatus, message: fail };

const oneOf = (name: string, value: string, allowed: readonly string[]): Check =>
  check(name, allowed.includes(value), `${value} is valid`, `'${value}' must be one of: ${allowed.join(", ")}`);

export function runProductTests(p: FinancialProduct): TestReport {
  const text = `${p.name} ${p.description} ${p.key_features.join(" ")}`.toLowerCase();
  const isCredit = p.product_line === "credit";
  const insuranceReturns = ["protection", "guaranteed_income", "guaranteed_plus_bonus", "market_linked"];
  const checks: Check[] = [
    oneOf("product_line", p.product_line, PRODUCT_LINES),
    check("name", p.name.trim().length >= 3, "Name present", "Name must be at least 3 characters"),
    check(
      "description",
      p.description.trim().length >= 30,
      "Description is descriptive enough",
      "Description must be at least 30 characters so users understand the product",
    ),
    check("key_features", p.key_features.length >= 2, `${p.key_features.length} features listed`, "List at least 2 key features"),
    check("regulator", p.regulator.trim().length > 0, "Regulator disclosed", "Regulator must be disclosed"),
    check("region", /^(global|[A-Z]{2})$/.test(p.region), `${p.region} is valid`, "Region must be 'global' or an ISO country code like IN or US"),
    oneOf("risk_level", p.risk_level, RISK_LEVELS),
    oneOf("liquidity", p.liquidity, LIQUIDITY),
    oneOf("typical_horizon", p.typical_horizon, HORIZONS),
    oneOf("return_type", p.return_type, RETURN_TYPES),
    check(
      "credit_consistency",
      isCredit === (p.return_type === "cost_of_credit") && (!isCredit || p.risk_level === "not_applicable"),
      "Credit fields consistent",
      "Credit products (and only credit products) use return_type 'cost_of_credit' with risk_level 'not_applicable'",
    ),
    check(
      "insurance_consistency",
      p.product_line !== "insurance" || insuranceReturns.includes(p.return_type),
      "Insurance fields consistent",
      `Insurance products must use return_type ${insuranceReturns.join(", ")}`,
    ),
    check(
      "misleading_claims",
      !(p.return_type === "market_linked" && /guarantee|assured|risk[- ]free/.test(text)),
      "No misleading return claims found",
      "Market-linked products cannot claim guaranteed, assured or risk-free returns",
    ),
    check(
      "risk_vs_return",
      !(p.return_type === "market_linked" && p.risk_level === "low"),
      "Risk rating plausible for return type",
      "Market-linked product rated low risk; double-check the rating",
      "warn",
    ),
  ];
  return {
    passed: checks.every((c) => c.status !== "fail"),
    fingerprint: fingerprint(p),
    ran_at: new Date().toISOString(),
    checks,
  };
}
