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
import { attributionFor, offersFor, registerGtmTools } from "./gtm.js";
import { runProductTests } from "./product-tests.js";
import { DuplicateError, effectiveRoles, type App, type Role, type Store, type User } from "./store.js";
import { registerVersioningTools } from "./versions.js";

// The name MCP clients show for this server.
export const SERVER_NAME = "mynt";

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

// Tools are registered per user, so each role only sees what it is allowed to call. Roles nest
// (innovator > developer > consumer). Guests (no token) get the read-only catalog tools.
export function createServer(store: Store, user: User | null = null): McpServer {
  const server = new McpServer({ name: SERVER_NAME, title: "Mynt: financial products", version: "0.5.0" });
  const roles = effectiveRoles(user?.roles ?? []);
  const has = (role: Role) => roles.includes(role);

  registerCatalogTools(server, store, user);
  if (has("consumer")) registerConsumerTools(server, store, user!);
  if (has("developer")) {
    registerDeveloperTools(server, store, user!);
    registerGtmTools(server, store, user!);
  }
  if (has("innovator")) {
    registerInnovatorTools(server, store, user!);
    registerVersioningTools(server, store, user!, productFields);
  }

  return server;
}

function registerCatalogTools(server: McpServer, store: Store, user: User | null) {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Return the current user, the roles they were granted and what those include (innovators are developers, developers are consumers). Guests can only browse.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(user ? { ...user, effective_roles: effectiveRoles(user.roles) } : { name: "guest", roles: [], effective_roles: [] }),
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
      const matches = filterProducts(await store.publishedProducts(), filter);
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
      const record = await store.getProduct(id);
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
      const products = await store.publishedProducts();
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
    async () => json(await Promise.all((await store.publishedApps()).map((app) => resolveApp(store, app)))),
  );

  server.registerResource(
    "catalog",
    "mynt://catalog",
    { title: "Published financial product catalog", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await store.publishedProducts(), null, 2) }],
    }),
  );
}

function registerConsumerTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "enroll_in_product",
    {
      title: "Enroll in a financial product",
      description:
        "Consumer: start using a published financial product (open, subscribe, apply or invest), on its live version. Pass campaign_id when enrolling from an offer in list_offers.",
      inputSchema: {
        product_id: z.string(),
        amount: z.number().positive().optional().describe("Amount to invest, deposit or borrow, if relevant"),
        campaign_id: z.string().optional().describe("The offer you are responding to, from list_offers"),
      },
    },
    async ({ product_id, amount, campaign_id }) => {
      if ((await store.getProduct(product_id))?.status !== "published") return fail(`No published product with id '${product_id}'`);
      let attribution = null;
      if (campaign_id) {
        const a = await attributionFor(store, user, campaign_id, product_id);
        if ("error" in a) return fail(a.error!);
        attribution = a;
      }
      try {
        return json(await store.createEnrollment(user.id, product_id, amount ?? null, attribution));
      } catch (e) {
        if (e instanceof DuplicateError) return fail(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "list_offers",
    {
      title: "My offers",
      description: "Consumer: live offers from campaigns aimed at you, with the products they're for. Enroll with enroll_in_product and the offer's campaign_id.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await offersFor(store, user)),
  );

  server.registerTool(
    "upgrade_enrollment",
    {
      title: "Upgrade an enrollment",
      description: "Consumer: move one of your enrollments onto the product's latest version (see upgrade_available in list_my_enrollments).",
      inputSchema: { enrollment_id: z.string() },
    },
    async ({ enrollment_id }) => {
      const e = await store.getEnrollment(enrollment_id);
      if (!e || e.user_id !== user.id) return fail(`No enrollment with id '${enrollment_id}'`);
      const record = await store.getProduct(e.product_id);
      if (e.status !== "active" || record?.status !== "published" || e.product_version >= record.version)
        return fail("No upgrade available for this enrollment");
      await store.upgradeEnrollments(e.product_id, e.id);
      return json({ ...(await store.getEnrollment(enrollment_id)), product: record.product });
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
    async ({ include_cancelled }) => {
      const enrollments = (await store.enrollmentsByUser(user.id)).filter((e) => include_cancelled || e.status === "active");
      return json(
        await Promise.all(
          enrollments.map(async (e) => {
            const record = await store.getProduct(e.product_id);
            return {
              ...e,
              product: record?.product,
              live_version: record?.version,
              upgrade_available: e.status === "active" && record?.status === "published" && e.product_version < record.version,
            };
          }),
        ),
      );
    },
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
      const e = await store.getEnrollment(enrollment_id);
      if (!e || e.user_id !== user.id) return fail(`No enrollment with id '${enrollment_id}'`);
      if (e.status === "cancelled") return fail("Enrollment is already cancelled");
      return json(await store.cancelEnrollment(enrollment_id));
    },
  );
}

async function resolveApp(store: Store, app: App) {
  const products = await Promise.all(app.product_ids.map(async (id) => ({ id, record: await store.getProduct(id) })));
  return {
    ...app,
    products: products.filter((p) => p.record?.status === "published").map((p) => p.record!.product),
    unavailable_product_ids: products.filter((p) => p.record?.status !== "published").map((p) => p.id),
  };
}

function registerDeveloperTools(server: McpServer, store: Store, user: User) {
  const unpublished = async (ids: string[]) => {
    const records = await Promise.all(ids.map((id) => store.getProduct(id)));
    return ids.filter((_, i) => records[i]?.status !== "published");
  };
  const ownApp = async (id: string) => {
    const app = await store.getApp(id);
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
      const bad = await unpublished(fields.product_ids);
      if (bad.length) return fail(`Products not available: ${bad.join(", ")}`);
      return json(await store.createApp(user.id, fields));
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
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const bad = await unpublished(changes.product_ids ?? []);
      if (bad.length) return fail(`Products not available: ${bad.join(", ")}`);
      const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      return json(await store.saveApp({ ...app, ...defined }));
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
    async () => json(await store.appsByOwner(user.id)),
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
      const app = await ownApp(app_id);
      return app ? json(await resolveApp(store, app)) : fail(`No app with id '${app_id}'`);
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
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const bad = await unpublished(app.product_ids);
      if (bad.length) return fail(`Cannot publish: products not available: ${bad.join(", ")}`);
      return json(await store.saveApp({ ...app, status: "published" }));
    },
  );
}

function registerInnovatorTools(server: McpServer, store: Store, user: User) {
  const ownProduct = async (id: string) => {
    const record = await store.getProduct(id);
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
      try {
        return json(await store.insertDraft(user.id, product));
      } catch (e) {
        if (e instanceof DuplicateError) return fail(e.message);
        throw e;
      }
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
      const record = await ownProduct(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      if (record.status === "published") return fail("The product is live; draft its next version with create_product_version");
      const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      return json(await store.saveProduct({ ...record.product, ...defined } as FinancialProduct, "draft"));
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
      const record = await ownProduct(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      // A pending draft version is what gets tested; otherwise the product itself.
      const draft = await store.draftVersion(id);
      const report = runProductTests(draft?.data ?? record.product);
      if (draft) await store.saveDraftVersionTest(id, report);
      else await store.saveTestReport(id, report);
      return json(draft ? { version: draft.version, ...report } : report);
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
      const record = await ownProduct(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      // A pending draft version goes live in place of the current one; otherwise the product itself.
      const draft = await store.draftVersion(id);
      if (!draft && record.status === "published") return fail("Product is already published; draft a new version with create_product_version");
      const data = draft?.data ?? record.product;
      const lastTest = draft ? draft.last_test : record.last_test;
      if (!lastTest || lastTest.fingerprint !== runProductTests(data).fingerprint)
        return fail("Product changed since its last test (or was never tested); run test_product first");
      if (!lastTest.passed) return fail("Last test failed; fix the failing checks and run test_product again");
      return json(draft ? await store.publishDraftVersion(id) : await store.publishCurrentVersion(id));
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
      const record = await ownProduct(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      if (record.status !== "published") return fail("Product is not published");
      return json(await store.setProductStatus(id, "unpublished"));
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
        await Promise.all(
          (await store.productsByOwner(user.id)).map(async (r) => ({
            ...r.product,
            status: r.status,
            version: r.version,
            draft_version: (await store.draftVersion(r.product.id))?.version ?? null,
            last_test_passed: r.last_test?.passed ?? null,
            published_at: r.published_at,
          })),
        ),
      ),
  );
}
