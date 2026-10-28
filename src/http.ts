import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import type { Store } from "./store.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

// Stateless Streamable HTTP: every POST /mcp authenticates its bearer token and gets a
// server built for that user's roles. Requests without a token are served as a guest.
async function handle(store: Store, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    await store.ping();
    return void res.writeHead(200).end("ok");
  }
  if (url.pathname !== "/mcp") return void res.writeHead(404).end();
  if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();

  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  const user = token ? ((await store.userByToken(token)) ?? null) : null;
  if (token && !user) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    return void res.end(JSON.stringify({ error: "Invalid token" }));
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return void res.writeHead(400).end("Invalid JSON");
  }
  const server = createServer(store, user);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createMcpHttpServer(store: Store): Server {
  return createHttpServer((req, res) =>
    handle(store, req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }),
  );
}
