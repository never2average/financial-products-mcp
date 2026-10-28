#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpHttpServer } from "./http.js";
import { createServer } from "./server.js";
import { ROLES, Store, type Role } from "./store.js";

const USAGE = `Usage:
  financial-products-mcp [serve]                         Run over stdio (token from FINANCIAL_PRODUCTS_TOKEN)
  financial-products-mcp serve-http [--port 3000] [--host 127.0.0.1]
  financial-products-mcp users add --name <name> --role <${ROLES.join("|")}> [--role ...]
  financial-products-mcp users list

Environment:
  FINANCIAL_PRODUCTS_DB     SQLite database path (default ~/.financial-products-mcp/db.sqlite)
  FINANCIAL_PRODUCTS_FILE   JSON catalog used to seed published products
  FINANCIAL_PRODUCTS_TOKEN  User token for stdio mode; omit to browse as a guest`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    role: { type: "string", multiple: true },
    port: { type: "string", default: "3000" },
    host: { type: "string", default: "127.0.0.1" },
    help: { type: "boolean", short: "h" },
  },
});

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const [command = "serve", sub] = positionals;
if (values.help) {
  console.log(USAGE);
} else if (command === "serve") {
  const store = new Store();
  const token = process.env.FINANCIAL_PRODUCTS_TOKEN;
  const user = token ? (store.userByToken(token) ?? die("FINANCIAL_PRODUCTS_TOKEN is not a valid token")) : null;
  await createServer(store, user).connect(new StdioServerTransport());
} else if (command === "serve-http") {
  const port = Number(values.port);
  createMcpHttpServer(new Store()).listen(port, values.host, () =>
    console.error(`financial-products MCP listening on http://${values.host}:${port}/mcp`),
  );
} else if (command === "users" && sub === "add") {
  const roles = values.role ?? [];
  if (!values.name || roles.length === 0) die(USAGE);
  const invalid = roles.filter((r) => !(ROLES as readonly string[]).includes(r));
  if (invalid.length) die(`Unknown role(s): ${invalid.join(", ")}. Use ${ROLES.join(", ")}`);
  const { user, token } = new Store().createUser(values.name!, [...new Set(roles)] as Role[]);
  console.log(JSON.stringify({ ...user, token }, null, 2));
  console.error("Save this token now; it is stored hashed and cannot be shown again.");
} else if (command === "users" && sub === "list") {
  console.log(JSON.stringify(new Store().listUsers(), null, 2));
} else {
  die(USAGE);
}
