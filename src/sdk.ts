import { createHash } from "node:crypto";
import { BuildTermsSchema, DEFAULT_PERMITTED, EXPERIENCE_ACTIONS } from "./access.js";
import type { BuildTerms, ProductRecord } from "./store.js";

// Generates versioned SDK bundles (an OpenAPI document plus typed clients) for the runtime API
// apps call with their keys: GET /v1/products, GET /v1/products/{id}, POST /v1/handoffs,
// POST /v1/events, and signed webhooks. Product text only ever lands in generated code as string
// literals (never in comments), so innovator-supplied content can't break the output.

export const SDK_LANGUAGES = ["typescript", "python"] as const;
export type SdkLanguage = (typeof SDK_LANGUAGES)[number];
export const HANDOFFS = ["deep_link", "initiate_onboarding"] as const;
export const EVENT_TYPES = ["view", "click", "handoff_started"] as const;
export const WEBHOOK_EVENTS = [
  "product.version_published",
  "product.unpublished",
  "product.suspended",
  "access.approved",
  "access.revoked",
  "request.decided",
  "handoff.completed",
  "handoff.failed",
] as const;

export interface SdkProduct {
  record: ProductRecord;
  issuer: string | null;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export const fullTerms = (t: BuildTerms) => {
  const terms = { ...BuildTermsSchema.parse({}), ...t };
  if (!terms.permitted_actions.length) terms.permitted_actions = [...DEFAULT_PERMITTED] as never;
  return terms;
};

// Stable JSON (sorted keys), so equal terms always hash the same.
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

export const termsHash = (t: BuildTerms) => createHash("sha256").update(stable(fullTerms(t))).digest("hex").slice(0, 16);

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const compareSemver = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

type FieldKind = "string" | "number" | "integer" | "boolean" | "string[]" | "number[]" | "object" | "unknown";
const kindOf = (v: unknown): FieldKind => {
  if (typeof v === "string") return "string";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "boolean") return "boolean";
  if (Array.isArray(v)) return v.every((x) => typeof x === "number") && v.length ? "number[]" : v.every((x) => typeof x === "string") ? "string[]" : "unknown";
  if (v && typeof v === "object") return "object";
  return "unknown";
};

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("") || "Product";

// Unique type names per product id, e.g. "green-fd" -> GreenFdProduct.
function typeNames(ids: string[]) {
  const used = new Set<string>();
  return new Map(
    ids.map((id) => {
      let base = pascal(id);
      if (/^\d/.test(base)) base = `P${base}`;
      let name = `${base}Product`;
      for (let i = 2; used.has(name); i++) name = `${base}Product${i}`;
      used.add(name);
      return [id, name];
    }),
  );
}

const fields = (p: SdkProduct) => Object.entries(p.record.product as unknown as Record<string, unknown>);

export function openApiDocument(name: string, version: string, baseUrl: string, products: SdkProduct[]) {
  const names = typeNames(products.map((p) => p.record.product.id));
  const jsonType = (k: FieldKind): Record<string, unknown> =>
    k === "string[]"
      ? { type: "array", items: { type: "string" } }
      : k === "number[]"
        ? { type: "array", items: { type: "number" } }
        : k === "unknown"
          ? {}
          : { type: k };
  const productSchemas = Object.fromEntries(
    products.map((p) => {
      const id = p.record.product.id;
      const terms = fullTerms(p.record.build_terms);
      const props: Record<string, unknown> = Object.fromEntries(fields(p).map(([k, v]) => [k, jsonType(kindOf(v))]));
      props.id = { type: "string", const: id };
      props.version = { type: "integer", minimum: 1 };
      props.build_terms = { $ref: "#/components/schemas/BuildTerms" };
      return [
        names.get(id)!,
        {
          type: "object",
          title: p.record.product.name,
          "x-mynt-product-id": id,
          "x-mynt-permitted-actions": terms.permitted_actions,
          "x-mynt-required-disclosures": terms.required_disclosures,
          "x-mynt-branding": terms.branding,
          properties: props,
          required: [...new Set([...fields(p).map(([k]) => k), "version", "build_terms"])],
        },
      ];
    }),
  );
  const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
  const errors = {
    "400": { description: "Invalid request", content: { "application/json": { schema: ref("Error") } } },
    "401": { description: "Missing or invalid app key", content: { "application/json": { schema: ref("Error") } } },
    "403": { description: "The app may not use this product or action", content: { "application/json": { schema: ref("Error") } } },
    "404": { description: "Not found", content: { "application/json": { schema: ref("Error") } } },
    "429": {
      description: "Rate limited",
      headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait" } },
      content: { "application/json": { schema: ref("Error") } },
    },
  };
  const productIds = products.map((p) => p.record.product.id);
  return {
    openapi: "3.1.0",
    info: {
      title: `${name} (Mynt app API)`,
      version,
      description:
        "Read the products your app may show, hand users off to the innovator's own regulated flow, and report engagement. Apps never collect funds or financial data.",
    },
    servers: [{ url: `${baseUrl}/v1`, description: "Use a mynt_test_ key for the sandbox and a mynt_live_ key in production" }],
    security: [{ appKey: [] }],
    paths: {
      "/products": {
        get: {
          operationId: "listProducts",
          summary: "Products this app may show",
          responses: {
            "200": { description: "Products", content: { "application/json": { schema: { type: "array", items: ref("Product") } } } },
            ...errors,
          },
        },
      },
      "/products/{id}": {
        get: {
          operationId: "getProduct",
          summary: "One product",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", enum: productIds } }],
          responses: { "200": { description: "The product", content: { "application/json": { schema: ref("Product") } } }, ...errors },
        },
      },
      "/handoffs": {
        post: {
          operationId: "startHandoff",
          summary: "Hand the user off to the innovator's flow",
          requestBody: { required: true, content: { "application/json": { schema: ref("HandoffRequest") } } },
          responses: { "200": { description: "Where to send the user", content: { "application/json": { schema: ref("Handoff") } } }, ...errors },
        },
      },
      "/events": {
        post: {
          operationId: "trackEvent",
          summary: "Report an engagement event",
          requestBody: { required: true, content: { "application/json": { schema: ref("Event") } } },
          responses: { "202": { description: "Accepted" }, ...errors },
        },
      },
    },
    webhooks: Object.fromEntries(
      WEBHOOK_EVENTS.map((t) => [
        t,
        {
          post: {
            summary: `${t} (signed with the Mynt-Signature header: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">)`,
            parameters: [{ name: "Mynt-Signature", in: "header", required: true, schema: { type: "string" } }],
            requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } },
            responses: { "200": { description: "Received" } },
          },
        },
      ]),
    ),
    components: {
      securitySchemes: { appKey: { type: "http", scheme: "bearer", description: "App key: mynt_live_… or mynt_test_…" } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } }, required: ["error", "message"] },
        BuildTerms: {
          type: "object",
          properties: {
            permitted_actions: { type: "array", items: { type: "string", enum: [...EXPERIENCE_ACTIONS] } },
            required_disclosures: { type: "array", items: { type: "string" } },
            banned_phrases: { type: "array", items: { type: "string" } },
            allowed_personas: { type: "array", items: { type: "string" } },
            branding: { type: "string" },
            commercials: { type: "object" },
          },
        },
        Product: { oneOf: [...names.values()].map(ref) },
        ...productSchemas,
        HandoffRequest: {
          type: "object",
          properties: {
            product_id: { type: "string", enum: productIds },
            action: { type: "string", enum: [...HANDOFFS] },
            consumer_ref: { type: "string", description: "Your own opaque reference for the user; never personal or financial data" },
          },
          required: ["product_id", "action"],
        },
        Handoff: { type: "object", properties: { handoff_id: { type: "string" }, redirect_url: { type: "string", format: "uri" } }, required: ["handoff_id", "redirect_url"] },
        Event: {
          type: "object",
          properties: { type: { type: "string", enum: [...EVENT_TYPES] }, product_id: { type: "string", enum: productIds }, screen: { type: "string" } },
          required: ["type", "product_id"],
        },
        WebhookEvent: {
          type: "object",
          properties: { id: { type: "string" }, type: { type: "string", enum: [...WEBHOOK_EVENTS] }, created_at: { type: "string" }, data: { type: "object" } },
          required: ["type"],
        },
      },
    },
  };
}

const lit = (v: unknown) => JSON.stringify(v);

function typescriptClient(name: string, version: string, baseUrl: string, products: SdkProduct[]): string {
  const names = typeNames(products.map((p) => p.record.product.id));
  const tsType = (k: FieldKind) =>
    ({ string: "string", number: "number", integer: "number", boolean: "boolean", "string[]": "string[]", "number[]": "number[]", object: "Record<string, unknown>", unknown: "unknown" })[k];
  const prop = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : lit(k));
  const models = products
    .map((p) => {
      const id = p.record.product.id;
      const body = fields(p)
        .filter(([k]) => k !== "id")
        .map(([k, v]) => `  ${prop(k)}: ${tsType(kindOf(v))};`)
        .join("\n");
      return `export interface ${names.get(id)} {\n  id: ${lit(id)};\n${body}\n  version: number;\n  build_terms: BuildTerms;\n}`;
    })
    .join("\n\n");
  const perProduct = (f: (p: SdkProduct) => unknown) =>
    `{\n${products.map((p) => `  ${lit(p.record.product.id)}: ${lit(f(p))},`).join("\n")}\n}`;
  const terms = (p: SdkProduct) => fullTerms(p.record.build_terms);
  const ids = products.map((p) => p.record.product.id);

  return `// Generated by Mynt: ${lit(name)} ${lit(version)}. Do not edit; generate a new release instead.
// Zero dependencies: uses the global fetch and node:crypto.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SDK_NAME = ${lit(name)};
export const SDK_VERSION = ${lit(version)};
export const DEFAULT_BASE_URL = ${lit(`${baseUrl}/v1`)};

export const PRODUCT_IDS = ${lit(ids)} as const;
export type ProductId = (typeof PRODUCT_IDS)[number];

export interface BuildTerms {
  permitted_actions: string[];
  required_disclosures: string[];
  banned_phrases: string[];
  allowed_personas: string[];
  branding: string;
  commercials?: { model: string; value?: number; notes?: string };
}

${models}

export interface ProductModels {
${products.map((p) => `  ${lit(p.record.product.id)}: ${names.get(p.record.product.id)};`).join("\n")}
}
export type Product = ProductModels[ProductId];

/** What each product lets experiences do (from its build terms). */
export const PERMITTED_ACTIONS = ${perProduct((p) => terms(p).permitted_actions)} as const;

/** Hand-offs each product permits; startHandoff only accepts these. */
export const PERMITTED_HANDOFFS = ${perProduct((p) => terms(p).permitted_actions.filter((a: string) => (HANDOFFS as readonly string[]).includes(a)))} as const;
export type HandoffAction<P extends ProductId> = (typeof PERMITTED_HANDOFFS)[P][number];

/** Text every experience must show with each product, verbatim. */
export const REQUIRED_DISCLOSURES = ${perProduct((p) => terms(p).required_disclosures)} as const;

/** How each product and its issuer or distributor must be labelled. */
export const BRANDING = ${perProduct((p) => terms(p).branding)} as const;

/** Who issues or distributes each product. */
export const ISSUERS = ${perProduct((p) => p.issuer ?? "")} as const;

/** Words or claims experiences must not use with each product. */
export const BANNED_PHRASES = ${perProduct((p) => terms(p).banned_phrases)} as const;

export function disclosuresFor<P extends ProductId>(productId: P): readonly string[] {
  const d = REQUIRED_DISCLOSURES[productId] as readonly string[] | undefined;
  if (!d) throw new Error("Unknown product: " + productId);
  return d;
}

export type EventType = ${EVENT_TYPES.map(lit).join(" | ")};
export type WebhookEventType = ${WEBHOOK_EVENTS.map(lit).join(" | ")};

export interface Handoff {
  handoff_id: string;
  redirect_url: string;
}

export interface WebhookEvent {
  id?: string;
  type: WebhookEventType;
  created_at?: string;
  data?: Record<string, unknown>;
}

export class MyntError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "MyntError";
  }
}

export interface MyntClientOptions {
  /** An app key: mynt_live_… in production, mynt_test_… for the sandbox. */
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class MyntClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MyntClientOptions) {
    if (!/^mynt_(live|test)_/.test(options.apiKey)) throw new Error("apiKey must be a mynt_live_ or mynt_test_ app key");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  get sandbox(): boolean {
    return this.apiKey.startsWith("mynt_test_");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: { Authorization: "Bearer " + this.apiKey, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let error = "http_" + res.status;
      let message = res.statusText;
      try {
        const e = (await res.json()) as { error?: string; message?: string };
        error = e.error ?? error;
        message = e.message ?? message;
      } catch {
        // Not JSON; keep the status.
      }
      const retry = res.headers.get("Retry-After");
      throw new MyntError(res.status, error, message, retry ? Number(retry) : undefined);
    }
    if (res.status === 202 || res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Products this app may show. */
  listProducts(): Promise<Product[]> {
    return this.request<Product[]>("GET", "/products");
  }

  getProduct<P extends ProductId>(productId: P): Promise<ProductModels[P]> {
    return this.request<ProductModels[P]>("GET", "/products/" + encodeURIComponent(productId));
  }

  /** Hands the user off to the innovator's own flow; redirect them to redirect_url. */
  startHandoff<P extends ProductId>(productId: P, action: HandoffAction<P>, consumerRef?: string): Promise<Handoff> {
    const allowed = PERMITTED_HANDOFFS[productId] as readonly string[];
    if (!allowed.includes(action as string)) return Promise.reject(new Error(productId + " does not permit " + String(action)));
    return this.request<Handoff>("POST", "/handoffs", { product_id: productId, action, ...(consumerRef ? { consumer_ref: consumerRef } : {}) });
  }

  async trackEvent(type: EventType, productId: ProductId, screen?: string): Promise<void> {
    await this.request<void>("POST", "/events", { type, product_id: productId, ...(screen ? { screen } : {}) });
  }
}

/**
 * Verifies a webhook's Mynt-Signature header (t=<unix>,v1=<hex>) against the raw request body and
 * returns the parsed event. Throws when the signature is missing, wrong or older than toleranceSeconds.
 */
export function verifyWebhook(rawBody: string | Uint8Array, header: string, secret: string, toleranceSeconds = 300): WebhookEvent {
  const parts = new Map<string, string[]>();
  for (const item of (header ?? "").split(",")) {
    const i = item.indexOf("=");
    if (i <= 0) continue;
    const k = item.slice(0, i).trim();
    parts.set(k, [...(parts.get(k) ?? []), item.slice(i + 1).trim()]);
  }
  const t = parts.get("t")?.[0];
  const signatures = parts.get("v1") ?? [];
  if (!t || !/^\\d+$/.test(t) || signatures.length === 0) throw new Error("Malformed Mynt-Signature header");
  if (toleranceSeconds > 0 && Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) throw new Error("Webhook timestamp outside tolerance");
  const body = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  const expected = createHmac("sha256", secret).update(t + "." + body).digest();
  const ok = signatures.some((s) => {
    if (!/^[0-9a-f]+$/i.test(s) || s.length !== expected.length * 2) return false;
    return timingSafeEqual(Buffer.from(s, "hex"), expected);
  });
  if (!ok) throw new Error("Invalid webhook signature");
  return JSON.parse(body) as WebhookEvent;
}
`;
}

const PY_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "),
);
const pyIdent = (k: string) => {
  let s = k.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^\d/.test(s) || !s) s = `f_${s}`;
  return PY_KEYWORDS.has(s) ? `${s}_` : s;
};
// Python literal for JSON-like data (JSON string escapes are valid in Python string literals).
const py = (v: unknown): string =>
  v === null || v === undefined
    ? "None"
    : typeof v === "boolean"
      ? (v ? "True" : "False")
      : Array.isArray(v)
        ? `(${v.map(py).join(", ")}${v.length === 1 ? "," : ""})`
        : typeof v === "object"
          ? `{${Object.entries(v).map(([k, x]) => `${lit(k)}: ${py(x)}`).join(", ")}}`
          : lit(v);

function pythonClient(name: string, version: string, baseUrl: string, products: SdkProduct[]): string {
  const names = typeNames(products.map((p) => p.record.product.id));
  const pyType = (k: FieldKind) =>
    ({ string: "str", number: "float", integer: "int", boolean: "bool", "string[]": "List[str]", "number[]": "List[float]", object: "Dict[str, Any]", unknown: "Any" })[k];
  const terms = (p: SdkProduct) => fullTerms(p.record.build_terms);
  const perProduct = (f: (p: SdkProduct) => unknown) =>
    `{\n${products.map((p) => `    ${lit(p.record.product.id)}: ${py(f(p))},`).join("\n")}\n}`;
  const classes = products
    .map((p) => {
      const id = p.record.product.id;
      const fs = fields(p).map(([k, v]) => ({ key: k, ident: pyIdent(k), type: pyType(kindOf(v)) }));
      const seen = new Set<string>(["version", "build_terms"]);
      const unique = fs.filter((f) => !seen.has(f.ident) && seen.add(f.ident));
      return `@dataclass(frozen=True)
class ${names.get(id)}:
    PRODUCT_ID: ClassVar[str] = ${lit(id)}
${unique.map((f) => `    ${f.ident}: ${f.type}`).join("\n")}
    version: int
    build_terms: Dict[str, Any]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "${names.get(id)}":
        return cls(
${unique.map((f) => `            ${f.ident}=d.get(${lit(f.key)}),`).join("\n")}
            version=d.get("version", 0),
            build_terms=d.get("build_terms") or {},
        )`;
    })
    .join("\n\n\n");

  return `# Generated by Mynt. Do not edit; generate a new release instead.
# Standard library only: urllib, json, hmac, hashlib, dataclasses.
from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, ClassVar, Dict, List, Literal, Optional, Tuple, Union

SDK_NAME = ${lit(name)}
SDK_VERSION = ${lit(version)}
DEFAULT_BASE_URL = ${lit(`${baseUrl}/v1`)}

PRODUCT_IDS: Tuple[str, ...] = ${py(products.map((p) => p.record.product.id))}

# What each product lets experiences do (from its build terms).
PERMITTED_ACTIONS: Dict[str, Tuple[str, ...]] = ${perProduct((p) => terms(p).permitted_actions)}

# Hand-offs each product permits; start_handoff only accepts these.
PERMITTED_HANDOFFS: Dict[str, Tuple[str, ...]] = ${perProduct((p) => terms(p).permitted_actions.filter((a: string) => (HANDOFFS as readonly string[]).includes(a)))}

# Text every experience must show with each product, verbatim.
REQUIRED_DISCLOSURES: Dict[str, Tuple[str, ...]] = ${perProduct((p) => terms(p).required_disclosures)}

# How each product and its issuer or distributor must be labelled.
BRANDING: Dict[str, str] = ${perProduct((p) => terms(p).branding)}

ISSUERS: Dict[str, str] = ${perProduct((p) => p.issuer ?? "")}

BANNED_PHRASES: Dict[str, Tuple[str, ...]] = ${perProduct((p) => terms(p).banned_phrases)}

EventType = Literal[${EVENT_TYPES.map(lit).join(", ")}]
HandoffAction = Literal[${HANDOFFS.map(lit).join(", ")}]


def disclosures_for(product_id: str) -> Tuple[str, ...]:
    if product_id not in REQUIRED_DISCLOSURES:
        raise KeyError("Unknown product: " + product_id)
    return REQUIRED_DISCLOSURES[product_id]


${classes}


Product = Union[${products.map((p) => names.get(p.record.product.id)).join(", ")}]
PRODUCT_MODELS: Dict[str, Any] = {
${products.map((p) => `    ${lit(p.record.product.id)}: ${names.get(p.record.product.id)},`).join("\n")}
}


@dataclass(frozen=True)
class Handoff:
    handoff_id: str
    redirect_url: str


class MyntError(Exception):
    def __init__(self, status: int, code: str, message: str, retry_after: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after


def _product(d: Dict[str, Any]) -> Any:
    model = PRODUCT_MODELS.get(d.get("id", ""))
    return model.from_dict(d) if model else d


class MyntClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL, timeout: float = 30.0) -> None:
        if not (api_key.startswith("mynt_live_") or api_key.startswith("mynt_test_")):
            raise ValueError("api_key must be a mynt_live_ or mynt_test_ app key")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    @property
    def sandbox(self) -> bool:
        return self.api_key.startswith("mynt_test_")

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Authorization": "Bearer " + self.api_key, "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
                return json.loads(raw) if raw and res.status not in (202, 204) else None
        except urllib.error.HTTPError as e:
            code, message = "http_%d" % e.code, str(e.reason)
            try:
                payload = json.loads(e.read())
                code, message = payload.get("error", code), payload.get("message", message)
            except (ValueError, AttributeError):
                pass
            retry = e.headers.get("Retry-After") if e.headers else None
            raise MyntError(e.code, code, message, int(retry) if retry and retry.isdigit() else None) from None

    def list_products(self) -> List[Any]:
        """Products this app may show."""
        return [_product(d) for d in self._request("GET", "/products")]

    def get_product(self, product_id: str) -> Any:
        return _product(self._request("GET", "/products/" + urllib.parse.quote(product_id, safe="")))

    def start_handoff(self, product_id: str, action: HandoffAction, consumer_ref: Optional[str] = None) -> Handoff:
        """Hands the user off to the innovator's own flow; redirect them to redirect_url."""
        if action not in PERMITTED_HANDOFFS.get(product_id, ()):
            raise ValueError("%s does not permit %s" % (product_id, action))
        body: Dict[str, Any] = {"product_id": product_id, "action": action}
        if consumer_ref:
            body["consumer_ref"] = consumer_ref
        r = self._request("POST", "/handoffs", body)
        return Handoff(handoff_id=r["handoff_id"], redirect_url=r["redirect_url"])

    def track_event(self, type: EventType, product_id: str, screen: Optional[str] = None) -> None:
        body: Dict[str, Any] = {"type": type, "product_id": product_id}
        if screen:
            body["screen"] = screen
        self._request("POST", "/events", body)


def verify_webhook(raw_body: Union[bytes, str], header: str, secret: str, tolerance_seconds: int = 300) -> Dict[str, Any]:
    """Verifies a Mynt-Signature header (t=<unix>,v1=<hex>) and returns the parsed event."""
    parts: Dict[str, List[str]] = {}
    for item in (header or "").split(","):
        key, sep, value = item.partition("=")
        if sep:
            parts.setdefault(key.strip(), []).append(value.strip())
    t = (parts.get("t") or [""])[0]
    signatures = parts.get("v1") or []
    if not t.isdigit() or not signatures:
        raise ValueError("Malformed Mynt-Signature header")
    if tolerance_seconds > 0 and abs(time.time() - int(t)) > tolerance_seconds:
        raise ValueError("Webhook timestamp outside tolerance")
    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    expected = hmac.new(secret.encode("utf-8"), t.encode("ascii") + b"." + body, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, s.lower()) for s in signatures):
        raise ValueError("Invalid webhook signature")
    return json.loads(body)
`;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mynt-sdk";

export function generateSdk(opts: { name: string; version: string; languages: SdkLanguage[]; baseUrl: string; products: SdkProduct[] }): GeneratedFile[] {
  const { name, version, languages, baseUrl, products } = opts;
  const pkg = slug(name);
  const files: GeneratedFile[] = [{ path: "openapi.json", content: JSON.stringify(openApiDocument(name, version, baseUrl, products), null, 2) + "\n" }];
  if (languages.includes("typescript")) {
    files.push(
      { path: "typescript/src/index.ts", content: typescriptClient(name, version, baseUrl, products) },
      {
        path: "typescript/package.json",
        content:
          JSON.stringify(
            { name: pkg, version, type: "module", main: "dist/index.js", types: "dist/index.d.ts", engines: { node: ">=18" }, scripts: { build: "tsc" } },
            null,
            2,
          ) + "\n",
      },
    );
  }
  if (languages.includes("python")) {
    const mod = pkg.replace(/-/g, "_").replace(/^(\d)/, "sdk_$1");
    files.push(
      { path: `python/${mod}/__init__.py`, content: pythonClient(name, version, baseUrl, products) },
      {
        path: "python/pyproject.toml",
        content: `[project]\nname = ${lit(pkg)}\nversion = ${lit(version)}\nrequires-python = ">=3.8"\ndependencies = []\n`,
      },
    );
  }
  files.push({
    path: "README.md",
    content: `# ${name.replace(/[\r\n]+/g, " ")} ${version}

Generated by Mynt for the app API at \`${baseUrl}/v1\`. Authenticate with an app key (\`mynt_test_…\` for the sandbox, \`mynt_live_…\` in production).

Products: ${products.map((p) => `\`${p.record.product.id}\` (v${p.record.version})`).join(", ")}.

Every screen that shows a product must render its required disclosures (\`disclosuresFor(id)\` / \`disclosures_for(id)\`) and branding. Onboarding, KYC and payments hand off to the innovator's own flow via \`startHandoff\` / \`start_handoff\`; apps never collect funds or financial data.
`,
  });
  return files;
}
