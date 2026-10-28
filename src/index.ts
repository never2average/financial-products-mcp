#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectPostgres } from "./db.js";
import { createMcpHttpServer } from "./http.js";
import { createServer } from "./server.js";
import { ROLES, Store, type Role } from "./store.js";

const USAGE = `Usage:
  financial-products-mcp [serve]                         Run over stdio (token from FINANCIAL_PRODUCTS_TOKEN)
  financial-products-mcp serve-http [--port 3000] [--host 127.0.0.1]
  financial-products-mcp users add --name <name> --role <${ROLES.join("|")}> [--role ...]
  financial-products-mcp users list

Environment:
  DATABASE_URL              Postgres connection string, e.g. your Supabase database (required)
  FINANCIAL_PRODUCTS_FILE   JSON catalog used to seed published products
  FINANCIAL_PRODUCTS_TOKEN  User token for stdio mode; omit to browse as a guest`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
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

const openStore = () =>
  Store.open(connectPostgres(process.env.DATABASE_URL ?? die("DATABASE_URL is required (your Supabase Postgres connection string)")));

const [command = "serve", sub] = positionals;
if (values.help) {
  console.log(USAGE);
} else if (command === "serve") {
  const store = await openStore();
  const token = process.env.FINANCIAL_PRODUCTS_TOKEN;
  const user = token ? ((await store.userByToken(token)) ?? die("FINANCIAL_PRODUCTS_TOKEN is not a valid token")) : null;
  await createServer(store, user).connect(new StdioServerTransport());
} else if (command === "serve-http") {
  const port = Number(values.port);
  const http = createMcpHttpServer(await openStore()).listen(port, values.host, () =>
    console.error(`financial-products MCP listening on http://${values.host}:${port}/mcp`),
  );
  process.on("SIGTERM", () => http.close(() => process.exit(0)));
} else if (command === "users" && sub === "add") {
  const roles = values.role ?? [];
  if (!values.name || roles.length === 0) die(USAGE);
  const invalid = roles.filter((r) => !(ROLES as readonly string[]).includes(r));
  if (invalid.length) die(`Unknown role(s): ${invalid.join(", ")}. Use ${ROLES.join(", ")}`);
  const store = await openStore();
  const { user, token } = await store.createUser(values.name!, [...new Set(roles)] as Role[]);
  console.log(JSON.stringify({ ...user, token }, null, 2));
  console.error("Save this token now; it is stored hashed and cannot be shown again.");
  await store.close();
} else if (command === "users" && sub === "list") {
  const store = await openStore();
  console.log(JSON.stringify(await store.listUsers(), null, 2));
  await store.close();
} else {
  die(USAGE);
}
