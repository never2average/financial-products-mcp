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
import { registerAdminTools, type AdminContext } from "./admin.js";
import { accessStatus, BuildTermsSchema, coveringLicenses, EXPERIENCE_ACTIONS, lintExperience, productEntity } from "./access.js";
import { runProductTests } from "./product-tests.js";
import { COURT_LEVELS, findLicenses, LEGISLATIVE_KINDS, normalizeModel, PRODUCT_ACTIONS, summarizeModel, type Regulator } from "./regulatory.js";
import { DEFAULT_FIELDS, resolveFields, TEMPLATE_KINDS, type TemplateKind } from "./grc.js";
import {
  ACCESS_MODES,
  DuplicateError,
  effectiveRoles,
  PRODUCT_ROLES,
  type App,
  type ProductRecord,
  type Role,
  type Store,
  type User,
} from "./store.js";
import { registerMarketplaceTools } from "./marketplace.js";
import { registerVersioningTools } from "./versions.js";
import { emitProductEvent, ensureRelease, registerRuntimeInnovatorTools, registerRuntimeTools } from "./runtime.js";

// The name MCP clients show for this server.
export const SERVER_NAME = "mynt";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const fail = (error: string) => ({ ...json({ error }), isError: true });

const productFields = {
  name: z.string().min(1),
  product_line: z.enum(PRODUCT_LINES),
  category: z.string().min(1).describe("A category admins have defined for this product line (see list_product_categories)"),
  region: z.string().describe("A region admins have defined: 'global' or a country code such as IN (see list_regions)"),
  risk_level: z.enum(RISK_LEVELS),
  liquidity: z.enum(LIQUIDITY),
  typical_horizon: z.enum(HORIZONS),
  return_type: z.enum(RETURN_TYPES),
  regulator: z.string(),
  description: z.string(),
  key_features: z.array(z.string()),
};

// Tools are registered per user, so each role only sees what it is allowed to call. Roles nest
// (admin > innovator > developer > consumer). Guests (no token) get the read-only catalog tools.
export function createServer(store: Store, user: User | null = null, ctx: AdminContext = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, title: "Mynt: financial products", version: "0.6.0" });
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
    registerMarketplaceTools(server, store, user!);
    registerRuntimeInnovatorTools(server, store, user!);
  }
  if (has("admin")) registerAdminTools(server, store, user!, ctx);

  return server;
}

function registerCatalogTools(server: McpServer, store: Store, user: User | null) {
  server.registerTool(
    "list_regions",
    {
      title: "Regions",
      description:
        "The geographies products can be offered in, with their regulators and which product lines have a documented launch procedure (defined by admins). Use get_region for the full regulatory picture.",
      inputSchema: { include_inactive: z.boolean().default(false).describe("Admins: include retired regions") },
      annotations: { readOnlyHint: true },
    },
    async ({ include_inactive }) =>
      json(
        (await store.referenceData(include_inactive && user?.roles.includes("admin"))).regions.map(({ ecosystem, procedures, sources, regulatory, ...r }) => ({
          ...r,
          procedures_for: [...new Set(procedures.map((p) => p.product_line))],
        })),
      ),
  );

  server.registerTool(
    "get_region",
    {
      title: "Region's regulatory picture",
      description:
        "Everything an innovator needs before launching in a region: its regulators, regulatory ecosystem, the legal procedure for each product line, and official sources.",
      inputSchema: {
        code: z.string(),
        product_line: z.enum(PRODUCT_LINES).optional().describe("Only the launch procedures for this product line"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ code, product_line }) => {
      const region = (await store.referenceData(user?.roles.includes("admin"))).regions.find((r) => r.code === code.trim());
      if (!region) return fail(`No region '${code}'; see list_regions`);
      return json({
        ...region,
        regulatory: summarizeModel(normalizeModel(region.regulatory)),
        procedures: region.procedures.filter((p) => !product_line || p.product_line === product_line),
      });
    },
  );

  const modelFor = async (code: string) => {
    const region = (await store.referenceData(user?.roles.includes("admin"))).regions.find((r) => r.code === code.trim());
    return region && normalizeModel(region.regulatory);
  };

  server.registerTool(
    "get_regulator",
    {
      title: "A regulator in full",
      description:
        "One regulator in a region: the product types and customer personas it supervises, and every licence it grants with its GRC (obligations, filings, risks, controls, repositories, allowed products and segments, mandatory stakeholders).",
      inputSchema: { region: z.string(), regulator_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ region, regulator_id }) => {
      const model = await modelFor(region);
      if (!model) return fail(`No region '${region}'; see list_regions`);
      const r = model.regulators.find((x) => x.id === regulator_id);
      return r ? json(r) : fail(`No regulator '${regulator_id}' in ${region}; see get_region`);
    },
  );

  server.registerTool(
    "list_legal_instruments",
    {
      title: "Law in a region",
      description:
        "A region's law in two branches: legislative (acts, ordinances, rules, regulations, master directions, circulars, guidelines, notifications, orders) and judiciary (court and tribunal decisions). Narrow by branch, legislative kind, court level, or what an item applies to or interprets.",
      inputSchema: {
        region: z.string(),
        branch: z.enum(["legislative", "judiciary"]).optional(),
        kind: z.enum(LEGISLATIVE_KINDS).optional().describe("Legislative items of this kind"),
        court_level: z.enum(COURT_LEVELS).optional().describe("Judgments from this level of court"),
        applies_to: z
          .string()
          .optional()
          .describe("Only items applying to this regulator, licence, product type or persona id (or legislation a judgment interprets)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ region, branch, kind, court_level, applies_to }) => {
      const model = await modelFor(region);
      if (!model) return fail(`No region '${region}'; see list_regions`);
      const touches = (item: { applies_to: Record<string, string[]> }) => Object.values(item.applies_to).some((ids) => ids.includes(applies_to!));
      return json({
        legislative:
          branch === "judiciary" || court_level
            ? []
            : model.legal.legislative.filter((l) => (!kind || l.kind === kind) && (!applies_to || l.issued_by === applies_to || touches(l))),
        judiciary:
          branch === "legislative" || kind
            ? []
            : model.legal.judiciary.filter(
                (j) => (!court_level || j.court_level === court_level) && (!applies_to || j.interprets.includes(applies_to) || touches(j)),
              ),
      });
    },
  );

  server.registerTool(
    "find_licenses",
    {
      title: "Which licence do I need?",
      description:
        "Licences in a region that permit an action (issuance, sale, purchase, secondary_sale, repackaging) on a product category for a customer persona, with the application steps, mandatory stakeholders and filings each brings.",
      inputSchema: {
        region: z.string(),
        category: z.string().optional().describe("A Mynt product category id, e.g. deposits"),
        action: z.enum(PRODUCT_ACTIONS).optional(),
        persona: z.string().optional().describe("A customer persona id from get_regulator"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ region, ...q }) => {
      const model = await modelFor(region);
      if (!model) return fail(`No region '${region}'; see list_regions`);
      return json(findLicenses(model, q));
    },
  );

  // Where each template kind lives inside a licence's GRC.
  const TEMPLATE_LOCATIONS: Record<TemplateKind, (grc: Regulator["license_types"][number]["grc"]) => { id: string }[]> = {
    control: (g) => g.registers.controls,
    inspection_event: (g) => g.registers.inspection_events,
    policy: (g) => g.repositories.policies,
    risk_model: (g) => g.repositories.risk_models,
    inspection_record: (g) => g.repositories.inspection_history,
  };

  server.registerTool(
    "get_template",
    {
      title: "How to define a required record",
      description:
        "A regulator's template for a record a licensee must keep (a control, policy, risk model, inspection record or inspection event): its guidance, the law behind it, and the full field schema the licensee's own record must follow. Omit template_id to list the licence's templates of that kind.",
      inputSchema: {
        region: z.string(),
        regulator_id: z.string(),
        license_id: z.string(),
        kind: z.enum(TEMPLATE_KINDS),
        template_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ region, regulator_id, license_id, kind, template_id }) => {
      const model = await modelFor(region);
      if (!model) return fail(`No region '${region}'; see list_regions`);
      const license = model.regulators.find((r) => r.id === regulator_id)?.license_types.find((l) => l._id === license_id);
      if (!license) return fail(`No licence '${license_id}' under '${regulator_id}' in ${region}; see get_regulator`);
      const list = TEMPLATE_LOCATIONS[kind](license.grc) as ({ id: string; name: string } & Record<string, unknown>)[];
      if (!template_id) return json(list.map((t) => ({ id: t.id, name: t.name, mandatory: t.mandatory, guidance: t.guidance })));
      const t = list.find((x) => x.id === template_id);
      if (!t) return fail(`No ${kind} template '${template_id}' in licence '${license_id}'`);
      const { fields, ...rest } = t;
      return json({ ...rest, kind, own_fields: fields, schema: resolveFields(kind, t as never) });
    },
  );

  server.registerTool(
    "list_template_defaults",
    {
      title: "Default record schemas",
      description:
        "The default field schema each template kind starts from (control, policy, risk_model, inspection_record, inspection_event), including its enums, e.g. control type, test method and frequency, test rating.",
      inputSchema: { kind: z.enum(TEMPLATE_KINDS).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ kind }) => json(kind ? { [kind]: DEFAULT_FIELDS[kind] } : DEFAULT_FIELDS),
  );

  server.registerTool(
    "list_product_categories",
    {
      title: "Product categories",
      description: "The product types products can have, and the product lines each is used in (defined by admins).",
      inputSchema: {
        product_line: z.enum(PRODUCT_LINES).optional(),
        include_inactive: z.boolean().default(false).describe("Admins: include retired categories"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ product_line, include_inactive }) =>
      json(
        (await store.referenceData(include_inactive && user?.roles.includes("admin"))).categories.filter(
          (c) => !product_line || c.product_lines.includes(product_line),
        ),
      ),
  );

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

// Products an app may show: published, and still accessible to the app's developer (access can be
// revoked or suspended by the product's innovator).
async function resolveApp(store: Store, app: App) {
  const owner = await store.getUser(app.owner_id);
  const products = await Promise.all(
    app.product_ids.map(async (id) => {
      const record = await store.getProduct(id);
      const access = record && owner ? await accessStatus(store, owner, record, app.id) : undefined;
      return { id, record, ok: record?.status === "published" && access?.granted === true };
    }),
  );
  return {
    ...app,
    products: products.filter((p) => p.ok).map((p) => p.record!.product),
    unavailable_product_ids: products.filter((p) => !p.ok).map((p) => p.id),
  };
}

// Developers build software on innovators' products; they never issue, sell or hold funds.
function registerDeveloperTools(server: McpServer, store: Store, user: User) {
  const ownApp = async (id: string) => {
    const app = await store.getApp(id);
    return app && app.owner_id === user.id ? app : undefined;
  };

  // Products a draft may include: published, and not private unless this developer was let in.
  const unusable = async (ids: string[], appId: string | null) => {
    const out: string[] = [];
    for (const id of ids) {
      const record = await store.getProduct(id);
      if (record?.status !== "published") out.push(`${id} (not published)`);
      else if (record.access_mode === "private" && !(await accessStatus(store, user, record, appId)).granted) out.push(`${id} (private)`);
    }
    return out;
  };

  const experienceFields = {
    disclosures: z.array(z.string().min(1)).optional().describe("Text the experience shows users, e.g. risk warnings the products require"),
    actions: z.array(z.enum(EXPERIENCE_ACTIONS)).min(1).optional().describe("What the experience does with the products (default: display)"),
  };

  server.registerTool(
    "list_buildable_products",
    {
      title: "Products you can build on",
      description:
        "Developer: published products you can build experiences on, with each one's access mode (open: build and publish; approval: build now, publish once the innovator approves; private: invitation only), build terms and who issues or distributes it.",
      inputSchema: {
        product_line: z.enum(PRODUCT_LINES).optional(),
        query: z.string().optional(),
        access_mode: z.enum(ACCESS_MODES).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ product_line, query, access_mode }) => {
      const q = query?.toLowerCase();
      const out = [];
      for (const p of await store.publishedProducts()) {
        if (product_line && p.product_line !== product_line) continue;
        if (q && !`${p.name} ${p.description}`.toLowerCase().includes(q)) continue;
        const record = (await store.getProduct(p.id))!;
        if (access_mode && record.access_mode !== access_mode) continue;
        const access = await accessStatus(store, user, record, null);
        if (record.access_mode === "private" && !access.granted) continue;
        const entity = await productEntity(store, record);
        out.push({
          id: p.id,
          name: p.name,
          product_line: p.product_line,
          region: p.region,
          action: record.action,
          by: entity?.name ?? (record.owner_id ? null : "Mynt reference catalogue"),
          access_mode: record.access_mode,
          access: access.via,
          build_terms: { ...BuildTermsSchema.parse({}), ...record.build_terms },
        });
      }
      return json(out);
    },
  );

  server.registerTool(
    "get_product_sdk",
    {
      title: "Integration kit for a product",
      description:
        "Developer: what you need to build on a product: its data shape, sample data for a sandbox, the actions and hand-offs you may use, the disclosures and branding you must show, and your access status.",
      inputSchema: { product_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id }) => {
      const record = await store.getProduct(product_id);
      if (record?.status !== "published") return fail(`No published product '${product_id}'`);
      const access = await accessStatus(store, user, record, null);
      if (record.access_mode === "private" && !access.granted) return fail(`'${product_id}' is private; ask its innovator for an invitation`);
      const entity = await productEntity(store, record);
      const terms = { ...BuildTermsSchema.parse({}), ...record.build_terms };
      return json({
        product: record.product,
        version: record.version,
        issued_or_distributed_by: entity?.name ?? null,
        action: record.action,
        underlying_product_ids: record.underlying_product_ids,
        access: { mode: record.access_mode, status: access.via },
        build_terms: terms,
        integration: {
          data_shape: Object.fromEntries(Object.entries(record.product).map(([k, v]) => [k, Array.isArray(v) ? "string[]" : typeof v])),
          sandbox_sample: { ...record.product, sandbox: true },
          actions: Object.fromEntries(
            EXPERIENCE_ACTIONS.map((a) => [a, terms.permitted_actions.includes(a) ? "permitted" : "not permitted"]),
          ),
          hand_off:
            "Onboarding, KYC and payments happen in the innovator's own regulated flow: deep_link or initiate_onboarding pass the user there. Experiences never collect funds or financial data themselves.",
        },
      });
    },
  );

  server.registerTool(
    "create_app",
    {
      title: "Create an app experience",
      description:
        "Developer: create a draft app experience (e.g. a retirement planner or first-salary starter kit) on published products. Declare what it does (actions) and the disclosures it shows; check_experience tells you whether it meets each product's terms.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().min(1),
        audience: z.string().min(1).describe("Who the experience is for, e.g. 'first-time investors in India'"),
        product_ids: z.array(z.string()).min(1),
        ...experienceFields,
      },
    },
    async (fields) => {
      const bad = await unusable(fields.product_ids, null);
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
        ...experienceFields,
      },
    },
    async ({ app_id, ...changes }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const bad = await unusable(changes.product_ids ?? [], app.id);
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

  // Access per product and the terms lint, for one of the developer's apps.
  const readiness = async (app: App) => {
    const records = (await Promise.all(app.product_ids.map((id) => store.getProduct(id)))).filter(Boolean) as ProductRecord[];
    const access = await Promise.all(
      app.product_ids.map(async (id) => {
        const record = records.find((r) => r.product.id === id);
        if (record?.status !== "published") return { product_id: id, granted: false, status: "unavailable" };
        const a = await accessStatus(store, user, record, app.id);
        return { product_id: id, granted: a.granted, status: a.via, request_id: a.request_id };
      }),
    );
    return { access, lint: lintExperience(app, records.filter((r) => r.status === "published")) };
  };

  server.registerTool(
    "check_experience",
    {
      title: "Check an experience against the products' terms",
      description:
        "Developer: for one of your apps, whether you have access to each product and whether the experience meets each product's build terms (permitted actions, required disclosures, banned wording). Both must pass to publish.",
      inputSchema: { app_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const r = await readiness(app);
      return json({ ready: r.access.every((a) => a.granted) && r.lint.passed, ...r });
    },
  );

  server.registerTool(
    "preview_app",
    {
      title: "Preview an app experience",
      description: "Developer: render one of your app experiences with full product details and flag products it can't show.",
      inputSchema: { app_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id }) => {
      const app = await ownApp(app_id);
      return app ? json(await resolveApp(store, app)) : fail(`No app with id '${app_id}'`);
    },
  );

  server.registerTool(
    "request_product_access",
    {
      title: "Ask to build on a product",
      description:
        "Developer: ask a product's innovator to let one of your apps go live with it. Open products need no request; approval products go to the innovator's inbox; private products need an invitation.",
      inputSchema: { app_id: z.string(), product_id: z.string(), note: z.string().default("").describe("What you're building and why") },
    },
    async ({ app_id, product_id, note }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const record = await store.getProduct(product_id);
      if (record?.status !== "published") return fail(`No published product '${product_id}'`);
      const access = await accessStatus(store, user, record, app.id);
      if (access.granted) return json({ product_id, granted: true, via: access.via, note: "No request needed" });
      if (record.access_mode === "private") return fail(`'${product_id}' is private; its innovator has to invite you`);
      if (access.via === "pending") return fail(`A request for '${product_id}' is already waiting (${access.request_id})`);
      if (!app.product_ids.includes(product_id)) await store.saveApp({ ...app, product_ids: [...app.product_ids, product_id] });
      return json(
        await store.createRequest({ kind: "product_access", product_id, app_id: app.id, campaign_id: null, requester_id: user.id, status: "pending", note }),
      );
    },
  );

  server.registerTool(
    "list_my_requests",
    {
      title: "My requests",
      description: "Developer: your access and campaign-launch requests and what innovators decided.",
      inputSchema: { status: z.enum(["pending", "approved", "rejected", "revoked"]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => json((await store.requestsBy(user.id)).filter((r) => !status || r.status === status)),
  );

  server.registerTool(
    "publish_app",
    {
      title: "Publish an app experience",
      description:
        "Developer: make one of your app experiences visible to everyone via list_apps. You need access to every product and the experience must meet each product's build terms (see check_experience).",
      inputSchema: { app_id: z.string() },
    },
    async ({ app_id }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const r = await readiness(app);
      const blocked = r.access.filter((a) => !a.granted);
      if (blocked.length || !r.lint.passed) {
        return {
          ...json({
            error: "Cannot publish yet",
            access_needed: blocked.map((b) => ({ product_id: b.product_id, status: b.status })),
            failed_checks: r.lint.checks.filter((c) => c.status === "fail"),
          }),
          isError: true,
        };
      }
      const published = await store.saveApp({ ...app, status: "published" });
      await ensureRelease(store, published, user.id);
      return json(published);
    },
  );

  // Runtime layer: API keys, webhooks, sandbox, releases, metrics.
  registerRuntimeTools(server, store, user, readiness);
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
      description:
        "Innovator: create a draft financial product. action says what your firm does with it: issuance (you are the issuer), sale (you distribute another issuer's products, e.g. as a mutual fund distributor) or repackaging (you bundle others' products, e.g. a model portfolio); for sale and repackaging name the underlying products. Publishing needs a verified licence covering that action. Run test_product, then publish_product.",
      inputSchema: {
        id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use a lowercase slug like 'green-fd'"),
        ...productFields,
        action: z.enum(PRODUCT_ROLES).default("issuance"),
        underlying_product_ids: z.array(z.string()).default([]).describe("For sale or repackaging: the published products this builds on"),
      },
    },
    async ({ action, underlying_product_ids, ...product }) => {
      if (action !== "issuance" && underlying_product_ids.length === 0) return fail(`A ${action} product must name its underlying_product_ids`);
      try {
        return json(await store.insertDraft(user.id, product, { entity_id: user.entity_id, action, underlying_product_ids }));
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
      const data = draft?.data ?? record.product;
      const report = runProductTests(data, await store.referenceData());
      if (draft) await store.saveDraftVersionTest(id, report);
      else await store.saveTestReport(id, report);
      // Advisory here; publish_product enforces it.
      const held = await coveringLicenses(store, user.entity_id, data.region, data.category, record.action);
      const licence = held.length
        ? { name: "licence_held", status: "pass", message: `Your entity holds ${held.map((h) => `${h.license_id} (${h.regulator_id}, ${h.registration_number})`).join(", ")}` }
        : {
            name: "licence_held",
            status: "warn",
            message: user.entity_id
              ? `Your entity holds no verified licence for ${record.action} of '${data.category}' in ${data.region}; register one with register_license`
              : "You don't belong to an entity yet; create one with create_entity, then register its licences",
          };
      const result = { ...report, checks: [...report.checks, licence] };
      return json(draft ? { version: draft.version, ...result } : result);
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
      // A regulated action needs a verified, in-force licence held by the innovator's entity.
      const held = await coveringLicenses(store, user.entity_id, data.region, data.category, record.action);
      if (held.length === 0)
        return fail(
          `Publishing needs a verified licence for ${record.action} of '${data.category}' in ${data.region}, held by your entity (see find_licenses, register_license)`,
        );
      const notLive = [];
      for (const u of record.underlying_product_ids) if ((await store.getProduct(u))?.status !== "published") notLive.push(u);
      if (notLive.length) return fail(`Underlying products aren't published: ${notLive.join(", ")}`);
      const live = draft ? await store.publishDraftVersion(id) : await store.publishCurrentVersion(id);
      await emitProductEvent(store, id, "product.version_published", { version: live.version });
      return json({
        ...live,
        licensed_under: held.map((h) => ({ regulator: h.regulator_id, license: h.license_id, registration_number: h.registration_number })),
      });
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
      const unpublished = await store.setProductStatus(id, "unpublished");
      await emitProductEvent(store, id, "product.unpublished");
      return json(unpublished);
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
