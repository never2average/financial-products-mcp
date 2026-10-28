import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PRODUCT_LINES = ["credit", "wealth", "insurance", "treasury"] as const;
export type ProductLine = (typeof PRODUCT_LINES)[number];

export const RISK_LEVELS =["low", "moderate", "high", "very_high", "not_applicable"] as const;
export const LIQUIDITY = ["high", "moderate", "low", "none", "not_applicable"] as const;
export const HORIZONS = ["short", "short_to_medium", "medium", "medium_to_long", "long"] as const;
export const RETURN_TYPES = [
  "fixed_interest",
  "variable_interest",
  "market_linked",
  "inflation_linked",
  "guaranteed_income",
  "guaranteed_plus_bonus",
  "protection",
  "cost_of_credit",
] as const;

export interface FinancialProduct {
  id: string;
  name: string;
  product_line: ProductLine;
  category: string;
  region: string;
  risk_level: string;
  liquidity: string;
  typical_horizon: string;
  return_type: string;
  regulator: string;
  description: string;
  key_features: string[];
}

export interface ProductFilter {
  product_line?: string;
  category?: string;
  region?: string;
  risk_level?: string;
  query?: string;
}

const DEFAULT_CATALOG = fileURLToPath(new URL("../data/products.json", import.meta.url));

// FINANCIAL_PRODUCTS_FILE lets you seed your own catalog with the same schema.
export function loadCatalog(path = process.env.FINANCIAL_PRODUCTS_FILE ?? DEFAULT_CATALOG): FinancialProduct[] {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) throw new Error(`Catalog at ${path} must be a JSON array`);
  return data as FinancialProduct[];
}

export function filterProducts(products: FinancialProduct[], f: ProductFilter): FinancialProduct[] {
  const eq = (a: string, b?: string) => !b || a.toLowerCase() === b.toLowerCase();
  const q = f.query?.toLowerCase();
  return products.filter(
    (p) =>
      eq(p.product_line, f.product_line) &&
      eq(p.category, f.category) &&
      // "global" products apply in every region
      (!f.region || eq(p.region, f.region) || p.region === "global") &&
      eq(p.risk_level, f.risk_level) &&
      (!q || [p.name, p.description, ...p.key_features].some((s) => s.toLowerCase().includes(q))),
  );
}

export function countBy(products: FinancialProduct[], key: keyof FinancialProduct): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of products) out[String(p[key])] = (out[String(p[key])] ?? 0) + 1;
  return out;
}
