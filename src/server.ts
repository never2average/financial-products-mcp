import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { countBy, filterProducts, loadCatalog, type FinancialProduct } from "./catalog.js";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function createServer(products: FinancialProduct[] = loadCatalog()): McpServer {
  const server = new McpServer({ name: "financial-products", version: "0.1.0" });

  server.registerTool(
    "list_products",
    {
      title: "List financial products",
      description:
        "Return financial products from the catalog, optionally filtered by category, region, risk level or a free-text query. Use list_categories to see valid filter values.",
      inputSchema: {
        category: z.string().optional().describe("e.g. deposits, mutual_funds, bonds, insurance, credit"),
        region: z.string().optional().describe("IN, US or global; global products are included for every region"),
        risk_level: z.string().optional().describe("low, moderate, high, very_high, not_applicable"),
        query: z.string().optional().describe("Case-insensitive match on name, description and features"),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset, ...filter }) => {
      const matches = filterProducts(products, filter);
      return json({ total: matches.length, offset, limit, products: matches.slice(offset, offset + limit) });
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get a financial product",
      description: "Return full details for one product by its id (e.g. 'ppf', 'index-fund').",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const product = products.find((p) => p.id === id);
      if (!product) return { ...json({ error: `No product with id '${id}'` }), isError: true };
      return json(product);
    },
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories and filter values",
      description: "Return the available categories, regions and risk levels with product counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      json({
        categories: countBy(products, "category"),
        regions: countBy(products, "region"),
        risk_levels: countBy(products, "risk_level"),
      }),
  );

  server.registerResource(
    "catalog",
    "financial-products://catalog",
    { title: "Full financial product catalog", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(products, null, 2) }] }),
  );

  return server;
}
