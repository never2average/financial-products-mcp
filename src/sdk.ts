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


// Pinned generator and runtime versions written into the generated packages. Keep these equal to
// the versions in Mynt's package.json (a test checks this).
export const OPENAPI_TYPESCRIPT_VERSION = "7.13.0";
export const OPENAPI_FETCH_VERSION = "0.17.0";
export const OPENAPI_PYTHON_CLIENT_VERSION = "0.29.1";

const lit = (v: unknown) => JSON.stringify(v);

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

// The per-product data both helper layers expose as constants.
function productData(products: SdkProduct[]) {
  const terms = (p: SdkProduct) => fullTerms(p.record.build_terms);
  const per = (f: (p: SdkProduct) => unknown) => products.map((p) => [p.record.product.id, f(p)] as const);
  return {
    ids: products.map((p) => p.record.product.id),
    permittedActions: per((p) => terms(p).permitted_actions),
    permittedHandoffs: per((p) => terms(p).permitted_actions.filter((a: string) => (HANDOFFS as readonly string[]).includes(a))),
    disclosures: per((p) => terms(p).required_disclosures),
    branding: per((p) => terms(p).branding),
    issuers: per((p) => p.issuer ?? ""),
    banned: per((p) => terms(p).banned_phrases),
  };
}

async function typescriptSchema(doc: object): Promise<string> {
  const { default: openapiTS, astToString } = await import("openapi-typescript");
  const ast = await openapiTS(structuredClone(doc) as never, { silent: true });
  return `// Generated by Mynt with openapi-typescript ${OPENAPI_TYPESCRIPT_VERSION} from ../../openapi.json. Do not edit.\n\n${astToString(ast)}`;
}

// The thin hand-written layer over the openapi-fetch client.
function typescriptHelpers(name: string, version: string, baseUrl: string, products: SdkProduct[]): string {
  const names = typeNames(products.map((p) => p.record.product.id));
  const d = productData(products);
  const obj = (rows: (readonly [string, unknown])[]) => `{\n${rows.map(([id, v]) => `  ${lit(id)}: ${lit(v)},`).join("\n")}\n}`;
  return `// Generated by Mynt: ${lit(name)} ${lit(version)}. Do not edit; generate a new release instead.
// The HTTP client is openapi-fetch over the types in ./schema.d.ts (openapi-typescript); this file adds
// Mynt's helpers: typed hand-offs, events, webhook verification and each product's terms.
import createClient, { type Client } from "openapi-fetch";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { components, paths } from "./schema.js";

export type { components, paths };

export const SDK_NAME = ${lit(name)};
export const SDK_VERSION = ${lit(version)};
export const DEFAULT_BASE_URL = ${lit(`${baseUrl}/v1`)};

export const PRODUCT_IDS = ${lit(d.ids)} as const;
export type ProductId = (typeof PRODUCT_IDS)[number];
export type Product = components["schemas"]["Product"];
${products.map((p) => `export type ${names.get(p.record.product.id)} = components["schemas"][${lit(names.get(p.record.product.id))}];`).join("\n")}
export type Handoff = components["schemas"]["Handoff"];
export type EventType = components["schemas"]["Event"]["type"];
export type WebhookEvent = components["schemas"]["WebhookEvent"];

/** What each product lets experiences do (from its build terms). */
export const PERMITTED_ACTIONS = ${obj(d.permittedActions)} as const;

/** Hand-offs each product permits; startHandoff only accepts these. */
export const PERMITTED_HANDOFFS = ${obj(d.permittedHandoffs)} as const;
export type HandoffAction<P extends ProductId> = (typeof PERMITTED_HANDOFFS)[P][number];

/** Text every experience must show with each product, verbatim. */
export const REQUIRED_DISCLOSURES = ${obj(d.disclosures)} as const;

/** How each product and its issuer or distributor must be labelled. */
export const BRANDING = ${obj(d.branding)} as const;

/** Who issues or distributes each product. */
export const ISSUERS = ${obj(d.issuers)} as const;

/** Words or claims experiences must not use with each product. */
export const BANNED_PHRASES = ${obj(d.banned)} as const;

export function disclosuresFor(productId: ProductId): readonly string[] {
  const d = REQUIRED_DISCLOSURES[productId] as readonly string[] | undefined;
  if (!d) throw new Error("Unknown product: " + productId);
  return d;
}

export class MyntError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MyntError";
  }
}

export interface MyntClientOptions {
  /** An app key: mynt_live_… in production, mynt_test_… for the sandbox. */
  apiKey: string;
  baseUrl?: string;
  fetch?: (input: Request) => Promise<Response>;
}

const fail = (response: Response, error: unknown) => {
  const e = (error ?? {}) as { error?: string; message?: string };
  return new MyntError(response.status, e.error ?? "http_" + response.status, e.message ?? response.statusText);
};

/** Creates the typed client: \`client\` is openapi-fetch for every operation; the helpers wrap the common ones. */
export function createMyntClient(options: MyntClientOptions) {
  if (!/^mynt_(live|test)_/.test(options.apiKey)) throw new Error("apiKey must be a mynt_live_ or mynt_test_ app key");
  const client: Client<paths> = createClient<paths>({
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\\/+$/, ""),
    headers: { Authorization: "Bearer " + options.apiKey },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return {
    client,
    sandbox: options.apiKey.startsWith("mynt_test_"),
    /** Hands the user off to the innovator's own flow; redirect them to redirect_url. */
    async startHandoff<P extends ProductId>(productId: P, action: HandoffAction<P>, consumerRef?: string): Promise<Handoff> {
      if (!(PERMITTED_HANDOFFS[productId] as readonly string[]).includes(action)) throw new Error(productId + " does not permit " + action);
      const { data, error, response } = await client.POST("/handoffs", {
        body: { product_id: productId, action, ...(consumerRef ? { consumer_ref: consumerRef } : {}) },
      });
      if (!data) throw fail(response, error);
      return data;
    },
    async trackEvent(type: EventType, productId: ProductId, screen?: string): Promise<void> {
      const { error, response } = await client.POST("/events", { body: { type, product_id: productId, ...(screen ? { screen } : {}) } });
      if (!response.ok) throw fail(response, error);
    },
  };
}
export type MyntClient = ReturnType<typeof createMyntClient>;

/**
 * Verifies a webhook's Mynt-Signature header (t=<unix>,v1=<hex HMAC-SHA256 of "t.body">) against the raw
 * body and returns the event. Throws when the signature is missing, wrong or older than toleranceSeconds.
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
  const ok = signatures.some((s) => /^[0-9a-f]+$/i.test(s) && s.length === expected.length * 2 && timingSafeEqual(Buffer.from(s, "hex"), expected));
  if (!ok) throw new Error("Invalid webhook signature");
  return JSON.parse(body) as WebhookEvent;
}
`;
}

// The thin hand-written Python layer; the client itself comes from openapi-python-client.
function pythonHelpers(name: string, version: string, baseUrl: string, products: SdkProduct[]): string {
  const d = productData(products);
  const dict = (rows: (readonly [string, unknown])[]) => `{\n${rows.map(([id, v]) => `    ${lit(id)}: ${py(v)},`).join("\n")}\n}`;
  return `# Generated by Mynt. Do not edit; generate a new release instead.
# Standard library only. The HTTP client is generated from ../openapi.json by generate.sh.
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, List, Tuple, Union

SDK_NAME = ${lit(name)}
SDK_VERSION = ${lit(version)}
DEFAULT_BASE_URL = ${lit(`${baseUrl}/v1`)}

PRODUCT_IDS: Tuple[str, ...] = ${py(d.ids)}

# What each product lets experiences do (from its build terms).
PERMITTED_ACTIONS: Dict[str, Tuple[str, ...]] = ${dict(d.permittedActions)}

# Hand-offs each product permits.
PERMITTED_HANDOFFS: Dict[str, Tuple[str, ...]] = ${dict(d.permittedHandoffs)}

# Text every experience must show with each product, verbatim.
REQUIRED_DISCLOSURES: Dict[str, Tuple[str, ...]] = ${dict(d.disclosures)}

# How each product and its issuer or distributor must be labelled.
BRANDING: Dict[str, str] = ${dict(d.branding)}

ISSUERS: Dict[str, str] = ${dict(d.issuers)}

# Words or claims experiences must not use with each product.
BANNED_PHRASES: Dict[str, Tuple[str, ...]] = ${dict(d.banned)}


def disclosures_for(product_id: str) -> Tuple[str, ...]:
    if product_id not in REQUIRED_DISCLOSURES:
        raise KeyError("Unknown product: " + product_id)
    return REQUIRED_DISCLOSURES[product_id]


def check_handoff(product_id: str, action: str) -> None:
    """Raises ValueError unless the product permits this hand-off; call before POST /handoffs."""
    if action not in PERMITTED_HANDOFFS.get(product_id, ()):
        raise ValueError("%s does not permit %s" % (product_id, action))


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
const jsonFile = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

export async function generateSdk(opts: { name: string; version: string; languages: SdkLanguage[]; baseUrl: string; products: SdkProduct[] }): Promise<GeneratedFile[]> {
  const { name, version, languages, baseUrl, products } = opts;
  const pkg = slug(name);
  const doc = openApiDocument(name, version, baseUrl, products);
  const files: GeneratedFile[] = [{ path: "openapi.json", content: jsonFile(doc) }];
  if (languages.includes("typescript")) {
    files.push(
      { path: "typescript/src/schema.d.ts", content: await typescriptSchema(doc) },
      { path: "typescript/src/index.ts", content: typescriptHelpers(name, version, baseUrl, products) },
      {
        path: "typescript/package.json",
        content: jsonFile({
          name: pkg,
          version,
          type: "module",
          main: "dist/index.js",
          types: "dist/index.d.ts",
          engines: { node: ">=18" },
          scripts: { generate: "openapi-typescript ../openapi.json -o src/schema.d.ts", build: `tsc && node -e "require('node:fs').copyFileSync('src/schema.d.ts', 'dist/schema.d.ts')"` },
          dependencies: { "openapi-fetch": OPENAPI_FETCH_VERSION },
          devDependencies: { "@types/node": "^22.0.0", "openapi-typescript": OPENAPI_TYPESCRIPT_VERSION, typescript: "^5.9.0" },
        }),
      },
      {
        path: "typescript/tsconfig.json",
        content: jsonFile({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2022", "DOM"],
            types: ["node"],
            strict: true,
            declaration: true,
            rootDir: "src",
            outDir: "dist",
          },
          include: ["src"],
        }),
      },
    );
  }
  if (languages.includes("python")) {
    const mod = pkg.replace(/-/g, "_").replace(/^(\d)/, "sdk_$1");
    files.push(
      { path: "python/mynt_helpers.py", content: pythonHelpers(name, version, baseUrl, products) },
      { path: "python/config.yml", content: `project_name_override: ${lit(pkg)}\npackage_name_override: ${lit(mod)}\npackage_version_override: ${lit(version)}\npost_hooks: []\n` },
      {
        path: "python/generate.sh",
        content: `#!/bin/sh
# Generates the Python client from ../openapi.json into ./${pkg} (package ${mod}).
set -eu
cd "$(dirname "$0")"
openapi-python-client generate --path ../openapi.json --config config.yml --meta setup --overwrite
`,
      },
      {
        path: "python/README.md",
        content: `# Python

The client is generated from \`../openapi.json\` with openapi-python-client:

\`\`\`sh
pip install openapi-python-client==${OPENAPI_PYTHON_CLIENT_VERSION}
sh generate.sh        # writes ./${pkg} (package ${mod})
pip install ./${pkg}
\`\`\`

\`\`\`python
from ${mod} import AuthenticatedClient
client = AuthenticatedClient(base_url=${lit(`${baseUrl}/v1`)}, token="mynt_test_...")
\`\`\`

Operations live in \`${mod}.api.default\` (\`list_products\`, \`get_product\`, \`start_handoff\`, \`track_event\`); product models are named after each product.

\`mynt_helpers.py\` (standard library only) holds each product's required disclosures (\`disclosures_for(id)\`), branding,
banned phrases and permitted hand-offs (\`check_handoff\`), and \`verify_webhook(raw_body, header, secret)\`.
`,
      },
    );
  }
  files.push({
    path: "README.md",
    content: `# ${name.replace(/[\r\n]+/g, " ")} ${version}

Generated by Mynt for the app API at \`${baseUrl}/v1\`. Authenticate with an app key (\`mynt_test_…\` for the sandbox, \`mynt_live_…\` in production).

Products: ${products.map((p) => `\`${p.record.product.id}\` (v${p.record.version})`).join(", ")}.

\`openapi.json\` is the contract. \`typescript/\` is an openapi-fetch client over types generated by openapi-typescript, plus Mynt helpers (\`createMyntClient\`, \`startHandoff\`, \`trackEvent\`, \`verifyWebhook\`). For Python, run \`python/generate.sh\` (openapi-python-client) and use \`python/mynt_helpers.py\`.

Every screen that shows a product must render its required disclosures (\`disclosuresFor(id)\` / \`disclosures_for(id)\`) and branding. Onboarding, KYC and payments hand off to the innovator's own flow (\`startHandoff\` / \`POST /handoffs\`); apps never collect funds or financial data.
`,
  });
  return files;
}
