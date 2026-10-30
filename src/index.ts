#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ClerkAdmin, ClerkAuth, clerkConfigFromEnv } from "./auth.js";
import { HttpBoatClient } from "./boat.js";
import { BuildService, buildConfigFromEnv } from "./builds.js";
import { connectPostgres } from "./db.js";
import { createMcpHttpServer } from "./http.js";
import { GitHubApp } from "./github.js";
import { createServer } from "./server.js";
import { ROLES, Store, type Role } from "./store.js";

const USAGE = `Usage:
  mynt [serve]                         Run over stdio (token from FINANCIAL_PRODUCTS_TOKEN)
  mynt serve-http [--port 3000] [--host 127.0.0.1]
  mynt users invite --email <email> --role <${ROLES.join("|")}> [--role ...]   (bootstrap; admins then use Mynt)
  mynt users revoke --email <email>
  mynt users add --name <name> --role <role> [--role ...]   Local token (stdio, or HTTP without Clerk)
  mynt users list
  mynt clerk setup                     Turn on Clerk's allowlist and MCP client registration

Environment:
  DATABASE_URL              Postgres connection string, e.g. your Supabase database (required)
  CLERK_SECRET_KEY          With CLERK_PUBLISHABLE_KEY and PUBLIC_URL: HTTP requires Clerk sign-in + whitelist
  CLERK_PUBLISHABLE_KEY
  PUBLIC_URL                Public origin of this server, e.g. https://mcp.example.com
  FINANCIAL_PRODUCTS_FILE   JSON catalog used to seed published products
  FINANCIAL_PRODUCTS_TOKEN  User token for stdio mode; omit to browse as a guest
  BOAT_API_KEY              Enables coding-agent builds in boat.dev sandboxes (BUILD_CAP_USD, BUILD_MONTHLY_CAP_USD, ...)
  GITHUB_APP_ID             With GITHUB_APP_PRIVATE_KEY and GITHUB_APP_SLUG: builds push branches and open PRs`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    email: { type: "string" },
    role: { type: "string", multiple: true },
    port: { type: "string", default: process.env.PORT ?? "3000" },
    host: { type: "string", default: process.env.HOST ?? "127.0.0.1" },
    help: { type: "boolean", short: "h" },
  },
});

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const openDb = () => connectPostgres(process.env.DATABASE_URL ?? die("DATABASE_URL is required (your Supabase Postgres connection string)"));
const openStore = () => Store.open(openDb());

// Coding-agent builds run in boat.dev sandboxes when a boat key is configured.
const openServices = async () => {
  const db = openDb();
  const store = await Store.open(db);
  const boat = process.env.BOAT_API_KEY ? new HttpBoatClient(process.env.BOAT_API_KEY) : null;
  const builds = await BuildService.open(db, store, boat, GitHubApp.fromEnv(), buildConfigFromEnv());
  return { store, builds };
};

const parseRoles = (): Role[] => {
  const roles = values.role ?? [];
  if (roles.length === 0) die(USAGE);
  const invalid = roles.filter((r) => !(ROLES as readonly string[]).includes(r));
  if (invalid.length) die(`Unknown role(s): ${invalid.join(", ")}. Use ${ROLES.join(", ")}`);
  return [...new Set(roles)] as Role[];
};

const parseEmail = (): string => {
  const email = values.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die("--email <address> is required");
  return email!;
};

const clerkAdmin = () => (process.env.CLERK_SECRET_KEY ? new ClerkAdmin(process.env.CLERK_SECRET_KEY) : null);

const [command = "serve", sub] = positionals;
if (values.help) {
  console.log(USAGE);
} else if (command === "serve") {
  const { store, builds } = await openServices();
  const token = process.env.FINANCIAL_PRODUCTS_TOKEN;
  const user = token ? ((await store.userByToken(token)) ?? die("FINANCIAL_PRODUCTS_TOKEN is not a valid token")) : null;
  await createServer(store, user, { clerkAdmin: clerkAdmin(), builds }).connect(new StdioServerTransport());
} else if (command === "serve-http") {
  const port = Number(values.port);
  const { store, builds } = await openServices();
  builds.startWorker();
  const config = clerkConfigFromEnv();
  const clerk = config ? new ClerkAuth(config, store) : null;
  const http = createMcpHttpServer(store, clerk, { clerkAdmin: clerkAdmin(), builds }).listen(port, values.host, () =>
    console.error(`mynt MCP listening on http://${values.host}:${port}/mcp${clerk ? " (Clerk whitelist auth)" : ""}`),
  );
  process.on("SIGTERM", () => http.close(() => process.exit(0)));
} else if (command === "users" && sub === "invite") {
  const email = parseEmail();
  const roles = parseRoles();
  const store = await openStore();
  const invite = await store.upsertInvite(email, roles);
  const warning = await clerkAdmin()?.allow(email);
  if (warning) console.error(`warning: ${email} ${warning}`);
  console.log(JSON.stringify(invite, null, 2));
  await store.close();
} else if (command === "users" && sub === "revoke") {
  const email = parseEmail();
  const store = await openStore();
  const removed = await store.deleteInvite(email);
  await clerkAdmin()?.disallow(email);
  console.log(removed ? `Revoked ${email}` : `${email} was not on the whitelist`);
  await store.close();
} else if (command === "users" && sub === "add") {
  if (!values.name) die(USAGE);
  const roles = parseRoles();
  const store = await openStore();
  const { user, token } = await store.createUser(values.name!, roles);
  console.log(JSON.stringify({ ...user, token }, null, 2));
  console.error("Save this token now; it is stored hashed and cannot be shown again.");
  await store.close();
} else if (command === "users" && sub === "list") {
  const store = await openStore();
  console.log(JSON.stringify({ whitelist: await store.listInvites(), users: await store.listUsers() }, null, 2));
  await store.close();
} else if (command === "clerk" && sub === "setup") {
  const admin = clerkAdmin() ?? die("CLERK_SECRET_KEY is required");
  const warnings = await admin.setup();
  // Keep Clerk's allowlist in step with the whitelist (e.g. on a new production instance).
  const store = await openStore();
  const invites = await store.listInvites();
  await store.close();
  for (const invite of invites) {
    const w = await admin.allow(invite.email);
    if (w) warnings.push(`${invite.email} ${w}`);
  }
  for (const w of warnings) console.error(`warning: ${w}`);
  console.log(
    `Clerk: ${warnings.length ? "" : "allowlist on, "}dynamic client registration on, PKCE required, audience claims on; ` +
      `${invites.length} whitelisted email(s) synced to the allowlist`,
  );
} else {
  die(USAGE);
}
