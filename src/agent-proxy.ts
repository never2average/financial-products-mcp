import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { BuildService } from "./builds.js";

// Claude Code in a build sandbox reaches Anthropic only through here (ANTHROPIC_BASE_URL=<public>/agent).
// It authenticates with its build's token, which works only while that build is running; Mynt adds
// its own Anthropic key and streams the response straight back. The sandbox never sees the key.

const UPSTREAM = "https://api.anthropic.com";
const PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const FORWARD_REQUEST = ["content-type", "anthropic-version", "anthropic-beta", "accept"];
const FORWARD_RESPONSE = ["content-type", "request-id", "retry-after", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-tokens-remaining"];
const MAX_BODY = 32 * 1024 * 1024;

const reply = (res: ServerResponse, status: number, message: string) =>
  void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "mynt_proxy_error", message } }));

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function agentProxy(builds: BuildService, req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname.slice("/agent".length);
  const key = builds.config.anthropicApiKey;
  if (!key) return reply(res, 503, "Builds aren't enabled");
  if (req.method !== "POST" || !PATHS.has(path)) return reply(res, 404, "Not found");
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-api-key"] ?? "");
  if (!token || !(await builds.agentTokenActive(token))) return reply(res, 401, "This build token isn't active");
  const body = await readBody(req);
  if (!body) return reply(res, 413, "Request too large");

  const headers: Record<string, string> = { "x-api-key": key };
  for (const h of FORWARD_REQUEST) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM}${path}${url.search}`, { method: "POST", headers, body: new Uint8Array(body), signal: abort.signal });
  } catch {
    return reply(res, 502, "Couldn't reach Anthropic");
  }
  const out: Record<string, string> = { "Cache-Control": "no-cache, no-transform" };
  for (const h of FORWARD_RESPONSE) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body) return void res.end();
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).on("error", () => res.destroy()).pipe(res);
}
