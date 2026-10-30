import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { APP_EVENT_TYPES, appProducts, buildTerms, HANDOFF_ACTIONS, resolveHandoff } from "./runtime.js";
import type { ApiKey, App, ProductRecord, Store } from "./store.js";

// The runtime REST API under /v1, for developers' shipped apps. Authenticated with a per-app key
// (Authorization: Bearer mynt_live_… / mynt_test_…), read-only over products, plus hand-offs to
// the innovator's own flow and analytics events. It never takes or returns consumer financial data.

export interface RuntimeApiOptions {
  publicUrl?: string; // origin used for sandbox hand-off URLs (default PUBLIC_URL, else the Host header)
  rateLimit?: { capacity: number; perMinute: number }; // per key (default 60 a minute)
  maxBodyBytes?: number; // default 16 KiB
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

// Token bucket per key: `capacity` requests at once, refilled at `perMinute`.
class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private capacity: number,
    private perMinute: number,
  ) {}

  // 0 if allowed, else seconds until the next request would be.
  take(key: string, now = Date.now()): number {
    const msPerToken = 60_000 / this.perMinute;
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) / msPerToken);
    b.at = now;
    if (this.buckets.size > 10_000) for (const [k, v] of this.buckets) if (v.tokens >= this.capacity) this.buckets.delete(k);
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - b.tokens) * msPerToken) / 1000));
  }
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  if (Number(req.headers["content-length"] ?? 0) > limit) throw new ApiError(413, "payload_too_large", `Request bodies are limited to ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, "payload_too_large", `Request bodies are limited to ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json", "The request body must be JSON");
  }
}

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(400, "invalid_request", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
};

// The app's own opaque id for its user: short, and not a phone, account or card number.
const consumerRef = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Use your own opaque id (letters, digits, _ and -, up to 64)")
  .refine((v) => !/\d{9,}/.test(v), "Looks like a phone, account or card number; send an opaque id, never personal or financial data");

const HandoffBody = z.object({ product_id: z.string().min(1).max(100), action: z.enum(HANDOFF_ACTIONS), consumer_ref: consumerRef.optional() }).strict();
const EventBody = z
  .object({
    type: z.enum(APP_EVENT_TYPES),
    product_id: z.string().min(1).max(100),
    screen: z.string().regex(/^[A-Za-z0-9 _./:-]{1,100}$/, "A screen name, up to 100 characters").optional(),
  })
  .strict();
const SandboxOutcome = z.object({ outcome: z.enum(["completed", "failed"]) }).strict();

// A product as the API shows it: its fields, live version, and build terms (the innovator's
// hand-off URL is used through POST /v1/handoffs, not handed out).
const productView = (r: ProductRecord) => {
  const { handoff_url, ...terms } = buildTerms(r);
  return { ...r.product, version: r.version, build_terms: terms };
};

export function createRuntimeApi(store: Store, opts: RuntimeApiOptions = {}) {
  const limiter = new RateLimiter(opts.rateLimit?.capacity ?? 60, opts.rateLimit?.perMinute ?? 60);
  const maxBody = opts.maxBodyBytes ?? 16 * 1024;

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const authenticate = async (req: IncomingMessage): Promise<{ key: ApiKey; app: App }> => {
    const auth = req.headers.authorization;
    const secret = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!/^mynt_(live|test)_/.test(secret)) throw new ApiError(401, "unauthorized", "Send your app's API key as Authorization: Bearer mynt_…", { "WWW-Authenticate": "Bearer" });
    const found = await store.apiKeyBySecret(secret);
    if (!found) throw new ApiError(401, "invalid_key", "The API key is unknown or revoked", { "WWW-Authenticate": 'Bearer error="invalid_token"' });
    return found;
  };

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL, cors: Record<string, string>) => {
    const method = req.method ?? "GET";
    const path = url.pathname.replace(/\/+$/, "");
    const allow = (methods: string) => {
      if (!methods.split(", ").includes(method)) throw new ApiError(405, "method_not_allowed", `Use ${methods}`, { Allow: methods });
    };

    // The page a sandbox redirect_url points at; it needs no key, and shows no app data.
    const sandboxPage = path.match(/^\/v1\/sandbox\/handoffs\/([^/]+)$/);
    if (sandboxPage && method === "GET") {
      const h = await store.getHandoff(sandboxPage[1]);
      if (!h?.sandbox) throw new ApiError(404, "not_found", "No such sandbox hand-off");
      return send(res, 200, {
        handoff_id: h.id,
        sandbox: true,
        status: h.status,
        message: "Simulated hand-off. Resolve it with the simulate_handoff tool or POST /v1/sandbox/handoffs/{id} with a sandbox key.",
      });
    }

    const { key, app } = await authenticate(req);
    const origin = req.headers.origin;
    if (origin) {
      if (!key.allowed_origins.includes(origin)) throw new ApiError(403, "origin_not_allowed", `Origin ${origin} isn't allowed for this key`);
      Object.assign(cors, { "Access-Control-Allow-Origin": origin, Vary: "Origin" });
    }
    const wait = limiter.take(key.id);
    if (wait) throw new ApiError(429, "rate_limited", "Too many requests for this key", { "Retry-After": String(wait) });
    const sandbox = key.environment === "sandbox";
    if (!sandbox && app.status !== "published") throw new ApiError(403, "app_not_published", "Live keys work once the app is published; use a sandbox key until then");

    const available = async (productId: string) => {
      const record = (await appProducts(store, app)).find((r) => r.product.id === productId);
      if (!record) throw new ApiError(404, "product_not_found", `Product '${productId}' isn't available to this app`);
      return record;
    };

    if (path === "/v1/products") {
      allow("GET");
      return send(res, 200, { products: (await appProducts(store, app)).map(productView) }, cors);
    }
    const one = path.match(/^\/v1\/products\/([^/]+)$/);
    if (one) {
      allow("GET");
      return send(res, 200, productView(await available(decodeURIComponent(one[1]))), cors);
    }
    if (path === "/v1/handoffs") {
      allow("POST");
      const body = parse(HandoffBody, await readJson(req, maxBody));
      const record = await available(body.product_id);
      const terms = buildTerms(record);
      if (!terms.permitted_actions.includes(body.action))
        throw new ApiError(403, "action_not_permitted", `'${record.product.id}' doesn't permit ${body.action} (permitted: ${terms.permitted_actions.join(", ")})`);
      const id = randomUUID();
      let redirect: string;
      if (sandbox) {
        const base = opts.publicUrl ?? process.env.PUBLIC_URL ?? `http://${req.headers.host ?? "localhost"}`;
        redirect = `${base.replace(/\/+$/, "")}/v1/sandbox/handoffs/${id}`;
      } else {
        if (!terms.handoff_url)
          throw new ApiError(409, "handoff_not_configured", `'${record.product.id}' has no handoff_url yet; its innovator sets one in the build terms`);
        const u = new URL(terms.handoff_url);
        u.searchParams.set("handoff_id", id);
        u.searchParams.set("app_id", app.id);
        redirect = u.toString();
      }
      const h = await store.createHandoff({
        id,
        app_id: app.id,
        key_id: key.id,
        product_id: record.product.id,
        action: body.action,
        consumer_ref: body.consumer_ref ?? null,
        sandbox,
        redirect_url: redirect,
      });
      return send(res, 201, { handoff_id: h.id, redirect_url: h.redirect_url, sandbox }, cors);
    }
    if (path === "/v1/events") {
      allow("POST");
      const body = parse(EventBody, await readJson(req, maxBody));
      const record = await available(body.product_id);
      const id = await store.recordAppEvent({ app_id: app.id, product_id: record.product.id, type: body.type, screen: body.screen ?? null, sandbox });
      return send(res, 202, { accepted: true, event_id: id, sandbox }, cors);
    }
    if (sandboxPage) {
      allow("GET, POST");
      if (!sandbox) throw new ApiError(403, "sandbox_only", "Resolve sandbox hand-offs with a sandbox key");
      const body = parse(SandboxOutcome, await readJson(req, maxBody));
      const h = await store.getHandoff(sandboxPage[1]);
      if (!h?.sandbox || h.app_id !== app.id) throw new ApiError(404, "not_found", "No such sandbox hand-off for this app");
      const resolved = await resolveHandoff(store, h, body.outcome);
      if (!resolved) throw new ApiError(409, "already_resolved", `The hand-off is already ${h.status}`);
      return send(res, 200, resolved, cors);
    }
    throw new ApiError(404, "not_found", `No route ${method} ${url.pathname}`);
  };

  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const origin = req.headers.origin;
    // Preflights carry no key, so allow an origin that any active key lists; the request itself
    // is then checked against its own key's origins.
    if (req.method === "OPTIONS") {
      const headers: Record<string, string> = { Vary: "Origin" };
      if (origin && (await store.originAllowed(origin)))
        Object.assign(headers, {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
        });
      return send(res, 204, undefined, headers);
    }
    const cors: Record<string, string> = {};
    try {
      await route(req, res, url, cors);
    } catch (e) {
      if (res.headersSent) throw e;
      if (!(e instanceof ApiError)) {
        console.error(e);
        return send(res, 500, { error: "internal_error", message: "Something went wrong on our side" }, cors);
      }
      // Don't keep the connection for the rest of an oversized body.
      send(res, e.status, { error: e.code, message: e.message }, { ...cors, ...e.headers, ...(e.status === 413 ? { Connection: "close" } : {}) });
    }
  };
}
