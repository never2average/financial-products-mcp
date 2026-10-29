import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ClerkAdmin } from "./auth.js";
import { PRODUCT_LINES } from "./catalog.js";
import { runProductTests } from "./product-tests.js";
import { ROLES, type Role, type Store, type User } from "./store.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

export interface AdminContext {
  clerkAdmin?: ClerkAdmin | null; // keeps Clerk's allowlist in step with the whitelist
}

// Admin: everything is managed through Mynt itself, and every change is written to the audit log.
export function registerAdminTools(server: McpServer, store: Store, user: User, ctx: AdminContext = {}) {
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);

  // ---- reference data ----

  server.registerTool(
    "define_region",
    {
      title: "Define a region",
      description:
        "Admin: add or change a geography products may be offered in: its regulators, regulatory ecosystem, the legal procedure to launch each product line there, and the official sources. Fields you leave out keep their current value. Set active=false to stop new products using it (live products stay).",
      inputSchema: {
        code: z.string().regex(/^(global|[A-Z]{2})$/, "Use 'global' or an ISO country code like IN, US, GB"),
        name: z.string().min(1).optional(),
        regulators: z
          .array(z.string().min(1))
          .optional()
          .describe("Short names of the regulators products here answer to, e.g. RBI, SEBI, IRDAI. test_product checks a product's regulator against these."),
        ecosystem: z
          .string()
          .optional()
          .describe("Markdown overview: each regulator's remit, the key laws and regulations, self-regulatory bodies, and how they interact"),
        procedures: z
          .array(
            z.object({
              product_line: z.enum(PRODUCT_LINES),
              name: z.string().min(1).describe("e.g. 'Mutual fund scheme launch'"),
              regulator: z.string().min(1),
              steps: z.array(z.string().min(1)).min(1).describe("Licences, registrations, approvals and filings, in order"),
              typical_timeline: z.string().optional(),
              notes: z.string().optional().describe("Thresholds, exemptions, ongoing obligations, caveats"),
            }),
          )
          .optional()
          .describe("How each product line is legally brought to market here. Replaces the region's whole list when given."),
        sources: z.array(z.string().url()).optional().describe("Official regulator or statute pages the content is drawn from"),
        active: z.boolean().optional(),
      },
    },
    async (region) => {
      const saved = await store.upsertRegion(region);
      await audit("define_region", region.code, region);
      return json(saved);
    },
  );

  server.registerTool(
    "define_product_category",
    {
      title: "Define a product category",
      description:
        "Admin: add or change a product type and the product lines (credit, wealth, insurance, treasury) it can be used in. Set active=false to retire it for new products.",
      inputSchema: {
        id: z.string().regex(/^[a-z][a-z0-9_]*$/, "Use a snake_case id like mutual_funds"),
        name: z.string().min(1),
        product_lines: z.array(z.enum(PRODUCT_LINES)).min(1),
        description: z.string().default(""),
        active: z.boolean().default(true),
      },
    },
    async (category) => {
      const saved = await store.upsertCategory(category);
      await audit("define_product_category", category.id, category);
      return json(saved);
    },
  );

  // ---- whitelist and users ----

  const adminInvites = async () => (await store.listInvites()).filter((i) => i.roles.includes("admin")).map((i) => i.email);

  server.registerTool(
    "list_whitelist",
    {
      title: "Whitelist",
      description: "Admin: who may sign in to Mynt and with which roles, plus the users who have signed in.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json({ whitelist: await store.listInvites(), users: await store.listUsers() }),
  );

  server.registerTool(
    "invite_user",
    {
      title: "Whitelist someone",
      description:
        "Admin: allow an email to sign in with the given roles, or change the roles of someone already whitelisted. Roles nest: admin > innovator > developer > consumer.",
      inputSchema: {
        email: z.string().email(),
        roles: z.array(z.enum(ROLES)).min(1),
      },
    },
    async ({ email, roles }) => {
      const lower = email.toLowerCase();
      const admins = await adminInvites();
      if (admins.includes(lower) && !roles.includes("admin") && admins.length === 1)
        return fail("That would remove the last admin; make someone else an admin first");
      const invite = await store.upsertInvite(lower, [...new Set(roles)] as Role[]);
      const warnings = [(await ctx.clerkAdmin?.allow(lower)) ?? null, await mirrorToClerk(lower, invite.roles)].filter(Boolean);
      await audit("invite_user", lower, { roles: invite.roles });
      return json({ ...invite, ...(warnings.length ? { warnings } : {}) });
    },
  );

  // Keep roles granted in Clerk (public metadata) in step with Mynt for people who have signed in.
  const mirrorToClerk = async (email: string, roles: Role[] | null): Promise<string | null> => {
    const clerkUserId = ctx.clerkAdmin ? await store.clerkIdForEmail(email) : null;
    if (!clerkUserId) return null;
    try {
      await ctx.clerkAdmin!.setRoles(clerkUserId, roles);
      return null;
    } catch (e) {
      return `roles not updated in Clerk (${(e as Error).message})`;
    }
  };

  server.registerTool(
    "revoke_user",
    {
      title: "Remove someone from the whitelist",
      description: "Admin: stop an email from using Mynt. Takes effect on their next request; what they created stays.",
      inputSchema: { email: z.string().email() },
      annotations: { destructiveHint: true },
    },
    async ({ email }) => {
      const lower = email.toLowerCase();
      const admins = await adminInvites();
      if (admins.length === 1 && admins[0] === lower) return fail("That is the last admin; make someone else an admin first");
      if (!(await store.deleteInvite(lower))) return fail(`${lower} is not on the whitelist`);
      await ctx.clerkAdmin?.disallow(lower);
      // Clear roles granted in Clerk too, or they would re-grant access on the next sign-in.
      const warning = await mirrorToClerk(lower, null);
      await audit("revoke_user", lower);
      return json({ revoked: lower, ...(warning ? { warning } : {}) });
    },
  );

  // ---- oversight ----

  server.registerTool(
    "list_all_campaigns",
    {
      title: "All campaigns",
      description: "Admin: every developer's campaigns, newest first.",
      inputSchema: { status: z.enum(["draft", "live", "paused", "ended"]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => json((await store.allCampaigns()).filter((c) => !status || c.status === status)),
  );

  server.registerTool(
    "admin_pause_campaign",
    {
      title: "Pause any campaign",
      description: "Admin: take any live campaign down now (e.g. a compliance issue). Its developer can fix and relaunch it.",
      inputSchema: { campaign_id: z.string(), reason: z.string().min(3) },
    },
    async ({ campaign_id, reason }) => {
      const c = await store.getCampaign(campaign_id);
      if (!c) return fail(`No campaign with id '${campaign_id}'`);
      if (c.status !== "live") return fail(`Campaign is ${c.status}, not live`);
      const saved = await store.saveCampaign({ ...c, status: "paused" });
      await audit("admin_pause_campaign", campaign_id, { reason, owner_id: c.owner_id });
      return json(saved);
    },
  );

  server.registerTool(
    "admin_set_product_status",
    {
      title: "Unpublish or republish any product",
      description:
        "Admin: unpublish any product (bundled ones included) now, or republish one; republishing runs the product tests against the current reference data and refuses if they fail.",
      inputSchema: { id: z.string(), status: z.enum(["published", "unpublished"]), reason: z.string().min(3) },
    },
    async ({ id, status, reason }) => {
      const record = await store.getProduct(id);
      if (!record) return fail(`No product with id '${id}'`);
      if (record.status === status) return fail(`Product is already ${status}`);
      if (status === "published") {
        const report = runProductTests(record.product, await store.referenceData());
        if (!report.passed) return { ...json({ error: "Cannot republish: the product fails its tests", ...report }), isError: true };
        await store.saveTestReport(id, report);
      }
      const saved = status === "published" ? await store.publishCurrentVersion(id) : await store.setProductStatus(id, "unpublished");
      await audit("admin_set_product_status", id, { status, reason, owner_id: record.owner_id });
      return json(saved);
    },
  );

  server.registerTool(
    "audit_log",
    {
      title: "Audit log",
      description: "Admin: recent admin actions, newest first, with who did them.",
      inputSchema: { limit: z.number().int().min(1).max(500).default(100) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => json(await store.auditLog(limit)),
  );
}
