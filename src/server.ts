import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  countBy,
  filterProducts,
  HORIZONS,
  LIQUIDITY,
  PRODUCT_LINES,
  RETURN_TYPES,
  RISK_LEVELS,
  type FinancialProduct,
} from "./catalog.js";
import { runProductTests } from "./product-tests.js";
import type { App, Role, Store, User } from "./store.js";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const fail = (error: string) => ({ ...json({ error }), isError: true });

const productFields = {
  name: z.string().min(1),
  product_line: z.enum(PRODUCT_LINES),
  category: z.string().min(1).describe("e.g. deposits, mutual_funds, bonds, insurance, credit"),
  region: z.string().describe("'global' or an ISO country code such as IN or US"),
  risk_level: z.enum(RISK_LEVELS),
  liquidity: z.enum(LIQUIDITY),
  typical_horizon: z.enum(HORIZONS),
  return_type: z.enum(RETURN_TYPES),
  regulator: z.string(),
  description: z.string(),
  key_features: z.array(z.string()),
};

// Tools are registered per user, so each role only sees what it is allowed to call.
// Guests (no token) get the read-only catalog tools.
export function createServer(store: Store, user: User | null = null): McpServer {
  const server = new McpServer({ name: "financial-products", version: "0.2.0" });
  const has = (role: Role) => user?.roles.includes(role) ?? false;

  registerCatalogTools(server, store, user);
  if (has("consumer")) registerConsumerTools(server, store, user!);
  if (has("developer")) registerDeveloperTools(server, store, user!);
  if (has("innovator")) registerInnovatorTools(server, store, user!);

  return server;
}

function registerCatalogTools(server: McpServer, store: Store, user: User | null) {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Return the current user and their roles (consumer, developer, innovator). Guests can only browse.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(user ?? { name: "guest", roles: [] }),
  );

  server.registerTool(
    "list_products",
    {
      title: "List financial products",
      description:
        "Return published financial products, optionally filtered by product line (credit, wealth, insurance, treasury), category, region, risk level or a free-text query. Use list_categories to see valid filter values.",
      inputSchema: {
        product_line: z.enum(PRODUCT_LINES).optional(),
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
      const matches = filterProducts(store.publishedProducts(), filter);
      return json({ total: matches.length, offset, limit, products: matches.slice(offset, offset + limit) });
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get a financial product",
      description: "Return full details for one product by its id (e.g. 'ppf', 'index-fund'). Innovators can also fetch their own drafts.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const record = store.getProduct(id);
      if (record?.status === "published") return json(record.product);
      if (record && user && record.owner_id === user.id) return json({ ...record.product, status: record.status, last_test: record.last_test });
      return fail(`No product with id '${id}'`);
    },
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories and filter values",
      description: "Return the product lines, categories, regions and risk levels of published products with counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const products = store.publishedProducts();
      return json({
        product_lines: Object.fromEntries(PRODUCT_LINES.map((l) => [l, products.filter((p) => p.product_line === l).length])),
        categories: countBy(products, "category"),
        regions: countBy(products, "region"),
        risk_levels: countBy(products, "risk_level"),
      });
    },
  );

  server.registerTool(
    "list_apps",
    {
      title: "List app experiences",
      description: "Return published app experiences that developers have built around financial products.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(store.publishedApps().map((app) => resolveApp(store, app))),
  );

  server.registerResource(
    "catalog",
    "financial-products://catalog",
    { title: "Published financial product catalog", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(store.publishedProducts(), null, 2) }],
    }),
  );
}

function registerConsumerTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "enroll_in_product",
    {
      title: "Enroll in a financial product",
      description: "Consumer: start using a published financial product (open, subscribe, apply or invest).",
      inputSchema: {
        product_id: z.string(),
        amount: z.number().positive().optional().describe("Amount to invest, deposit or borrow, if relevant"),
      },
    },
    async ({ product_id, amount }) => {
      if (store.getProduct(product_id)?.status !== "published") return fail(`No published product with id '${product_id}'`);
      const active = store.enrollmentsByUser(user.id).find((e) => e.product_id === product_id && e.status === "active");
      if (active) return fail(`Already enrolled in '${product_id}' (enrollment ${active.id})`);
      return json(store.createEnrollment(user.id, product_id, amount ?? null));
    },
  );

  server.registerTool(
    "list_my_enrollments",
    {
      title: "List my enrollments",
      description: "Consumer: list the financial products you are enrolled in, with product details.",
      inputSchema: { include_cancelled: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    async ({ include_cancelled }) =>
      json(
        store
          .enrollmentsByUser(user.id)
          .filter((e) => include_cancelled || e.status === "active")
          .map((e) => ({ ...e, product: store.getProduct(e.product_id)?.product })),
      ),
  );

  server.registerTool(
    "cancel_enrollment",
    {
      title: "Cancel an enrollment",
      description: "Consumer: stop using a financial product you are enrolled in.",
      inputSchema: { enrollment_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ enrollment_id }) => {
      const e = store.getEnrollment(enrollment_id);
      if (!e || e.user_id !== user.id) return fail(`No enrollment with id '${enrollment_id}'`);
      if (e.status === "cancelled") return fail("Enrollment is already cancelled");
      return json(store.cancelEnrollment(enrollment_id));
    },
  );
}

function resolveApp(store: Store, app: App) {
  const products = app.product_ids.map((id) => ({ id, record: store.getProduct(id) }));
  return {
    ...app,
    products: products.filter((p) => p.record?.status === "published").map((p) => p.record!.product),
    unavailable_product_ids: products.filter((p) => p.record?.status !== "published").map((p) => p.id),
  };
}

function registerDeveloperTools(server: McpServer, store: Store, user: User) {
  const unpublished = (ids: string[]) => ids.filter((id) => store.getProduct(id)?.status !== "published");
  const ownApp = (id: string) => {
    const app = store.getApp(id);
    return app && app.owner_id === user.id ? app : undefined;
  };

  server.registerTool(
    "create_app",
    {
      title: "Create an app experience",
      description: "Developer: create a draft app experience (e.g. a retirement planner or first-salary starter kit) that bundles published products.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().min(1),
        audience: z.string().min(1).describe("Who the experience is for, e.g. 'first-time investors in India'"),
        product_ids: z.array(z.string()).min(1),
      },
    },
    async (fields) => {
      const bad = unpublished(fields.product_ids);
      if (bad.length) return fail(`Products not available: ${bad.join(", ")}`);
      return json(store.createApp(user.id, fields));
    },
  );

  server.registerTool(
    "update_app",
    {
      title: "Update an app experience",
      description: "Developer: change one of your app experiences. Only fields you pass are changed.",
      inputSchema: {
        app_id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        audience: z.string().min(1).optional(),
        product_ids: z.array(z.string()).min(1).optional(),
      },
    },
    async ({ app_id, ...changes }) => {
      const app = ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const bad = unpublished(changes.product_ids ?? []);
      if (bad.length) return fail(`Products not available: ${bad.join(", ")}`);
      const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      return json(store.saveApp({ ...app, ...defined }));
    },
  );

  server.registerTool(
    "list_my_apps",
    {
      title: "List my app experiences",
      description: "Developer: list the app experiences you have built, drafts included.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(store.appsByOwner(user.id)),
  );

  server.registerTool(
    "preview_app",
    {
      title: "Preview an app experience",
      description: "Developer: render one of your app experiences with full product details and flag products that are no longer available.",
      inputSchema: { app_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id }) => {
      const app = ownApp(app_id);
      return app ? json(resolveApp(store, app)) : fail(`No app with id '${app_id}'`);
    },
  );

  server.registerTool(
    "publish_app",
    {
      title: "Publish an app experience",
      description: "Developer: make one of your app experiences visible to everyone via list_apps. All its products must be published.",
      inputSchema: { app_id: z.string() },
    },
    async ({ app_id }) => {
      const app = ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const bad = unpublished(app.product_ids);
      if (bad.length) return fail(`Cannot publish: products not available: ${bad.join(", ")}`);
      return json(store.saveApp({ ...app, status: "published" }));
    },
  );
}

function registerInnovatorTools(server: McpServer, store: Store, user: User) {
  const ownProduct = (id: string) => {
    const record = store.getProduct(id);
    return record && record.owner_id === user.id ? record : undefined;
  };

  server.registerTool(
    "create_product",
    {
      title: "Create a financial product",
      description: "Innovator: create a draft financial product. Run test_product, then publish_product to list it in the catalog.",
      inputSchema: {
        id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use a lowercase slug like 'green-fd'"),
        ...productFields,
      },
    },
    async (product) => {
      if (store.getProduct(product.id)) return fail(`Product id '${product.id}' is taken`);
      return json(store.insertDraft(user.id, product));
    },
  );

  server.registerTool(
    "update_product",
    {
      title: "Update a draft financial product",
      description: "Innovator: edit one of your draft or unpublished products. Only fields you pass are changed; you must re-test before publishing.",
      inputSchema: {
        id: z.string(),
        ...Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, v.optional()])),
      } as { id: z.ZodString } & { [K in keyof typeof productFields]: z.ZodOptional<(typeof productFields)[K]> },
    },
    async ({ id, ...changes }) => {
      const record = ownProduct(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      if (record.status === "published") return fail("Unpublish the product before editing it");
      const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      return json(store.saveProduct({ ...record.product, ...defined } as FinancialProduct, "draft"));
    },
  );

  server.registerTool(
    "test_product",
    {
      title: "Test a financial product",
      description:
        "Innovator: run disclosure, consistency and misleading-claim checks on one of your products. A passing report is required to publish.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const record = ownProduct(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      const report = runProductTests(record.product);
      store.saveTestReport(id, report);
      return json(report);
    },
  );

  server.registerTool(
    "publish_product",
    {
      title: "Publish a financial product",
      description: "Innovator: list one of your tested products in the public catalog so consumers and developers can use it.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const record = ownProduct(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      if (record.status === "published") return fail("Product is already published");
      const fresh = runProductTests(record.product);
      if (!record.last_test || record.last_test.fingerprint !== fresh.fingerprint)
        return fail("Product changed since its last test (or was never tested); run test_product first");
      if (!record.last_test.passed) return fail("Last test failed; fix the failing checks and run test_product again");
      return json(store.setProductStatus(id, "published"));
    },
  );

  server.registerTool(
    "unpublish_product",
    {
      title: "Unpublish a financial product",
      description: "Innovator: remove one of your products from the catalog. Existing enrollments are kept; no new ones can be made.",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const record = ownProduct(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      if (record.status !== "published") return fail("Product is not published");
      return json(store.setProductStatus(id, "unpublished"));
    },
  );

  server.registerTool(
    "list_my_products",
    {
      title: "List my financial products",
      description: "Innovator: list the products you created with their status and latest test result.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      json(
        store.productsByOwner(user.id).map((r) => ({
          ...r.product,
          status: r.status,
          last_test_passed: r.last_test?.passed ?? null,
          published_at: r.published_at,
        })),
      ),
  );
}
