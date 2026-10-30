import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { BuildService } from "./builds.js";

// Claude Code in a build sandbox reaches the model only through here, authenticated by its build's
// token, which works only while that build is running. Mynt adds its own credentials and streams the
// response straight back; the sandbox never sees them. Two backends:
//   - Anthropic API: ANTHROPIC_BASE_URL=<public>/agent, token as the bearer; /agent/v1/messages[...]
//   - Vertex AI: ANTHROPIC_VERTEX_BASE_URL=<public>/agent/t/<token>/v1 with Claude Code's Google auth
//     skipped; Mynt pins the project and region, and signs with its service account.

const ANTHROPIC_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const VERTEX_PATH = /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/anthropic\/models\/(claude-[a-z0-9.@-]+|count-tokens):(rawPredict|streamRawPredict)$/;
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

export const vertexHost = (region: string) => (region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`);

export async function agentProxy(builds: BuildService, req: IncomingMessage, res: ServerResponse, url: URL) {
  const backend = builds.config.agentBackend;
  if (!backend) return reply(res, 503, "Builds aren't enabled");
  if (req.method !== "POST") return reply(res, 404, "Not found");

  let token: string;
  let upstream: string;
  const headers: Record<string, string> = {};
  if (backend.kind === "vertex") {
    const m = /^\/agent\/t\/([A-Za-z0-9_-]+)(\/.*)$/.exec(url.pathname);
    const route = m && VERTEX_PATH.exec(m[2]);
    if (!m || !route) return reply(res, 404, "Not found");
    token = m[1];
    upstream = `https://${vertexHost(backend.region)}/v1/projects/${backend.projectId}/locations/${backend.region}/publishers/anthropic/models/${route[1]}:${route[2]}`;
  } else {
    const path = url.pathname.slice("/agent".length);
    if (!ANTHROPIC_PATHS.has(path)) return reply(res, 404, "Not found");
    const auth = req.headers.authorization ?? "";
    token = auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-api-key"] ?? "");
    upstream = `https://api.anthropic.com${path}${url.search}`;
    headers["x-api-key"] = backend.apiKey;
  }
  if (!token || !(await builds.agentTokenActive(token))) return reply(res, 401, "This build token isn't active");
  const body = await readBody(req);
  if (!body) return reply(res, 413, "Request too large");
  for (const h of FORWARD_REQUEST) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  if (backend.kind === "vertex") {
    try {
      headers.authorization = `Bearer ${await backend.auth.accessToken()}`;
    } catch {
      return reply(res, 502, "Couldn't get a Google Cloud access token");
    }
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let up: Response;
  try {
    up = await fetch(upstream, { method: "POST", headers, body: new Uint8Array(body), signal: abort.signal });
  } catch {
    return reply(res, 502, "Couldn't reach the model provider");
  }
  const out: Record<string, string> = { "Cache-Control": "no-cache, no-transform" };
  for (const h of FORWARD_RESPONSE) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(up.status, out);
  if (!up.body) return void res.end();
  Readable.fromWeb(up.body as import("node:stream/web").ReadableStream).on("error", () => res.destroy()).pipe(res);
}
