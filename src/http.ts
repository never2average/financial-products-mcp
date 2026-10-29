import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AdminContext } from "./admin.js";
import type { ClerkAuth } from "./auth.js";
import { createServer } from "./server.js";
import type { Store, User } from "./store.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

// Clerk's authorization server metadata, mirrored on this origin for clients that look for it here.
function authServerMetadata(issuer: string) {
  let cached: { at: number; body: unknown } | null = null;
  return async () => {
    if (!cached || Date.now() - cached.at > 3_600_000) {
      const r = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
      if (!r.ok) throw new Error(`Clerk metadata ${r.status}`);
      cached = { at: Date.now(), body: await r.json() };
    }
    return cached.body;
  };
}

// With Clerk configured, every MCP request needs a Clerk OAuth access token for a whitelisted user;
// local fpm_ tokens and guests are refused. Without it, fpm_ tokens and read-only guests are served.
async function authenticate(
  store: Store,
  clerk: ClerkAuth | null,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ user: User | null } | null> {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;

  if (clerk) {
    const challenge = (extra = "") => `Bearer resource_metadata="${clerk.resourceMetadataUrl}"${extra}`;
    if (!token) {
      sendJson(res, 401, { error: "unauthorized", message: "Sign in with Clerk" }, { "WWW-Authenticate": challenge() });
      return null;
    }
    const result = await clerk.authenticate(token);
    if (!result.ok) {
      const headers: Record<string, string> = result.status === 401 ? { "WWW-Authenticate": challenge(`, error="invalid_token"`) } : {};
      sendJson(res, result.status, { error: result.error, message: result.message }, headers);
      return null;
    }
    return { user: result.user };
  }

  const user = token ? ((await store.userByToken(token)) ?? null) : null;
  if (token && !user) {
    sendJson(res, 401, { error: "Invalid token" }, { "WWW-Authenticate": "Bearer" });
    return null;
  }
  return { user };
}

async function handle(
  store: Store,
  clerk: ClerkAuth | null,
  meta: (() => Promise<unknown>) | null,
  ctx: AdminContext,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    await store.ping();
    return void res.writeHead(200).end("ok");
  }
  if (clerk && req.method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return sendJson(res, 200, clerk.protectedResourceMetadata(), { "Cache-Control": "public, max-age=3600" });
  }
  if (meta && req.method === "GET" && url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
    return sendJson(res, 200, await meta(), { "Cache-Control": "public, max-age=3600" });
  }
  if (url.pathname !== "/mcp") return void res.writeHead(404).end();
  if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();

  const authed = await authenticate(store, clerk, req, res);
  if (!authed) return;

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return void res.writeHead(400).end("Invalid JSON");
  }
  const server = createServer(store, authed.user, ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createMcpHttpServer(store: Store, clerk: ClerkAuth | null = null, ctx: AdminContext = {}): Server {
  const meta = clerk ? authServerMetadata(clerk.issuer) : null;
  return createHttpServer((req, res) =>
    handle(store, clerk, meta, ctx, req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }),
  );
}
