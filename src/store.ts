import { createHash, randomBytes, randomUUID } from "node:crypto";
import { loadCatalog, type FinancialProduct } from "./catalog.js";
import type { Db } from "./db.js";
import type { TestReport } from "./product-tests.js";
import type { RegulatoryModel } from "./regulatory.js";

export const ROLES = ["consumer", "developer", "innovator", "admin"] as const;
export type Role = (typeof ROLES)[number];

// Roles nest: every admin is an innovator, every innovator a developer, every developer a consumer.
const IMPLIES: Record<Role, Role[]> = { consumer: [], developer: ["consumer"], innovator: ["developer"], admin: ["innovator"] };

// Reference data admins manage: where products may be offered and what kinds of product exist.
// How a product line is legally brought to market in a region: licences, approvals, filings.
export interface LaunchProcedure {
  product_line: string;
  name: string; // e.g. "Mutual fund scheme launch"
  regulator: string;
  steps: string[];
  typical_timeline?: string;
  notes?: string;
}

export interface Region {
  code: string; // ISO 3166-1 alpha-2, or "global"
  name: string;
  regulators: string[];
  ecosystem: string; // how the regulators, key laws and bodies fit together
  procedures: LaunchProcedure[];
  sources: string[]; // official pages the above is drawn from
  regulatory: RegulatoryModel; // regulators, scope, licences + GRC, and legal instruments
  active: boolean;
  updated_at: string;
}

// Fields left out keep their current value, so a partial update never wipes researched content.
export type RegionUpdate = Pick<Region, "code"> & Partial<Omit<Region, "code" | "updated_at" | "regulatory">>;

export interface ProductCategory {
  id: string;
  name: string;
  product_lines: string[];
  description: string;
  active: boolean;
  updated_at: string;
}

export interface ReferenceData {
  regions: Region[];
  categories: ProductCategory[];
}

export interface AuditEntry {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target: string;
  details: unknown;
  created_at: string;
}

const KNOWN_REGIONS: Record<string, { name: string; regulators: string[] }> = {
  global: { name: "Global", regulators: [] },
  IN: { name: "India", regulators: ["RBI", "SEBI", "IRDAI", "PFRDA", "EPFO", "Ministry of Finance"] },
  US: { name: "United States", regulators: ["SEC", "FINRA", "FDIC", "NCUA", "CFPB", "CFTC", "IRS", "US Treasury", "Department of Labor", "State insurance regulators"] },
};

const titleCase = (id: string) => id.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// Regions and categories implied by a catalog, so the bundled products are valid from the start.
export function referenceSeed(products: FinancialProduct[]) {
  const regions = [...new Set(["global", ...products.map((p) => p.region)])].map((code) => ({
    code,
    name: KNOWN_REGIONS[code]?.name ?? code,
    regulators: KNOWN_REGIONS[code]?.regulators ?? [],
  }));
  const lines = new Map<string, Set<string>>();
  for (const p of products) lines.set(p.category, (lines.get(p.category) ?? new Set()).add(p.product_line));
  const categories = [...lines].map(([id, l]) => ({ id, name: titleCase(id), product_lines: [...l].sort() }));
  return { regions, categories };
}

export function effectiveRoles(roles: Role[]): Role[] {
  const out = new Set<Role>();
  const add = (r: Role) => {
    if (out.has(r)) return;
    out.add(r);
    IMPLIES[r].forEach(add);
  };
  roles.forEach(add);
  return ROLES.filter((r) => out.has(r));
}

export interface User {
  id: string;
  name: string;
  roles: Role[];
  email: string | null;
  entity_id: string | null;
  created_at: string;
}

export interface Invite {
  email: string;
  roles: Role[];
  created_at: string;
}

export type ProductStatus = "draft" | "published" | "unpublished";
export interface ProductRecord {
  product: FinancialProduct;
  owner_id: string | null; // null = bundled catalog product
  status: ProductStatus;
  version: number;
  last_test: TestReport | null;
  entity_id: string | null;
  action: ProductAction;
  underlying_product_ids: string[];
  access_mode: AccessMode;
  build_terms: BuildTerms;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

// Issuers create products; distributors sell and repackagers bundle other issuers' products.
export const PRODUCT_ROLES = ["issuance", "sale", "repackaging"] as const;
export type ProductAction = (typeof PRODUCT_ROLES)[number];
export const ACCESS_MODES = ["open", "approval", "private"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];
export interface BuildTerms {
  permitted_actions?: string[];
  required_disclosures?: string[];
  banned_phrases?: string[];
  allowed_personas?: string[];
  branding?: string;
  commercials?: { model: string; value?: number; notes?: string };
}

export interface Entity {
  id: string;
  name: string;
  registration_numbers: Record<string, string>;
  regions: string[];
  created_by: string | null;
  created_at: string;
}

export type LicenseStatus = "pending" | "verified" | "rejected" | "suspended";
export interface HeldLicense {
  id: string;
  entity_id: string;
  region: string;
  regulator_id: string;
  license_id: string;
  registration_number: string;
  valid_from: string | null;
  valid_to: string | null;
  status: LicenseStatus;
  submitted_by: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export type RequestKind = "product_access" | "campaign_launch";
export type RequestStatus = "pending" | "approved" | "rejected" | "revoked";
export interface AccessRequest {
  id: string;
  kind: RequestKind;
  product_id: string;
  app_id: string | null;
  campaign_id: string | null;
  requester_id: string;
  status: RequestStatus;
  note: string;
  decision_note: string | null;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface ProductVersion {
  product_id: string;
  version: number;
  status: "draft" | "published" | "superseded";
  data: FinancialProduct;
  changelog: string;
  last_test: TestReport | null;
  created_at: string;
  published_at: string | null;
}

export interface Enrollment {
  id: string;
  user_id: string;
  product_id: string;
  product_version: number;
  amount: number | null;
  status: "active" | "cancelled";
  campaign_id: string | null;
  variant: string | null;
  created_at: string;
}

export interface SegmentCriteria {
  enrolled_in?: string[]; // active in any of these products
  enrolled_in_lines?: string[]; // active in any product of these lines
  not_enrolled_in?: string[]; // active in none of these products
}

export interface Segment {
  id: string;
  owner_id: string;
  name: string;
  criteria: SegmentCriteria;
  created_at: string;
}

export interface Variant {
  key: string;
  headline: string;
  body: string;
  cta: string;
}

export type CampaignStatus = "draft" | "pending_approval" | "live" | "paused" | "ended";
export interface Campaign {
  id: string;
  owner_id: string;
  name: string;
  product_ids: string[];
  segment_id: string | null;
  channels: string[];
  variants: Variant[];
  status: CampaignStatus;
  last_lint: unknown;
  created_at: string;
  updated_at: string;
  launched_at: string | null;
}

export interface App {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  audience: string;
  product_ids: string[];
  disclosures: string[];
  actions: string[];
  status: "draft" | "published";
  created_at: string;
  updated_at: string;
}

// --- SDKs and experiences (developer build layer) ---
export interface Sdk {
  id: string;
  owner_id: string;
  name: string;
  languages: string[];
  product_ids: string[];
  created_at: string;
}

// What a release was generated from, per product, so later changes can flag it stale.
export interface SdkReleaseSource {
  product_id: string;
  version: number;
  terms_hash: string;
  access: string;
}

export interface SdkRelease {
  sdk_id: string;
  version: string;
  changelog: string;
  sources: SdkReleaseSource[];
  files: { path: string; content: string }[];
  created_at: string;
}
// --- end SDKs and experiences ---

export class DuplicateError extends Error {}

// Kept out of `public` so Supabase's auto-generated REST API never exposes these tables.
const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.users (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    roles text[] NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.products (
    id text PRIMARY KEY,
    owner_id uuid REFERENCES financial_products.users(id),
    status text NOT NULL CHECK (status IN ('draft', 'published', 'unpublished')),
    data jsonb NOT NULL,
    last_test jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS products_owner_idx ON financial_products.products (owner_id);
  CREATE TABLE IF NOT EXISTS financial_products.enrollments (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES financial_products.users(id),
    product_id text NOT NULL REFERENCES financial_products.products(id),
    amount numeric,
    status text NOT NULL CHECK (status IN ('active', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS enrollments_one_active_idx
    ON financial_products.enrollments (user_id, product_id) WHERE status = 'active';
  CREATE TABLE IF NOT EXISTS financial_products.apps (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES financial_products.users(id),
    name text NOT NULL,
    description text NOT NULL,
    audience text NOT NULL,
    product_ids text[] NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'published')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS apps_owner_idx ON financial_products.apps (owner_id);
  -- Clerk sign-in: a user is linked to a Clerk user and holds no local token.
  ALTER TABLE financial_products.users ALTER COLUMN token_hash DROP NOT NULL;
  ALTER TABLE financial_products.users ADD COLUMN IF NOT EXISTS clerk_user_id text UNIQUE;
  ALTER TABLE financial_products.users ADD COLUMN IF NOT EXISTS email text UNIQUE;
  -- The whitelist: only these emails may use the server over Clerk, with these roles. Removing an
  -- invite cuts the user off on their next request.
  CREATE TABLE IF NOT EXISTS financial_products.invites (
    email text PRIMARY KEY CHECK (email = lower(email)),
    roles text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- Versioning: products.data/version is the live version; product_versions keeps every published
  -- version and at most one draft of the next one.
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
  CREATE TABLE IF NOT EXISTS financial_products.product_versions (
    product_id text NOT NULL REFERENCES financial_products.products(id),
    version integer NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'published', 'superseded')),
    data jsonb NOT NULL,
    changelog text NOT NULL,
    last_test jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    PRIMARY KEY (product_id, version)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS product_versions_one_draft_idx
    ON financial_products.product_versions (product_id) WHERE status = 'draft';
  -- GTM: segments over consumers' enrollment behaviour, campaigns with A/B variants, attribution.
  CREATE TABLE IF NOT EXISTS financial_products.segments (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES financial_products.users(id),
    name text NOT NULL,
    criteria jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.campaigns (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES financial_products.users(id),
    name text NOT NULL,
    product_ids text[] NOT NULL,
    segment_id uuid REFERENCES financial_products.segments(id),
    channels text[] NOT NULL,
    variants jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'live', 'paused', 'ended')),
    last_lint jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    launched_at timestamptz
  );
  ALTER TABLE financial_products.enrollments ADD COLUMN IF NOT EXISTS product_version integer NOT NULL DEFAULT 1;
  ALTER TABLE financial_products.enrollments ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES financial_products.campaigns(id);
  ALTER TABLE financial_products.enrollments ADD COLUMN IF NOT EXISTS variant text;
  -- Admin-managed reference data and the audit log of admin actions.
  CREATE TABLE IF NOT EXISTS financial_products.regions (
    code text PRIMARY KEY CHECK (code = 'global' OR code ~ '^[A-Z]{2}$'),
    name text NOT NULL,
    regulators text[] NOT NULL DEFAULT '{}',
    active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE financial_products.regions ADD COLUMN IF NOT EXISTS ecosystem text NOT NULL DEFAULT '';
  ALTER TABLE financial_products.regions ADD COLUMN IF NOT EXISTS procedures jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE financial_products.regions ADD COLUMN IF NOT EXISTS sources text[] NOT NULL DEFAULT '{}';
  ALTER TABLE financial_products.regions ADD COLUMN IF NOT EXISTS regulatory jsonb NOT NULL DEFAULT '{"regulators": [], "legal": []}';
  -- Legal is split into legislative and judiciary branches; convert the earlier flat list once.
  ALTER TABLE financial_products.regions ALTER COLUMN regulatory
    SET DEFAULT '{"regulators": [], "legal": {"legislative": [], "judiciary": []}}';
  UPDATE financial_products.regions SET regulatory = jsonb_set(regulatory, '{legal}', jsonb_build_object(
    'legislative', COALESCE((SELECT jsonb_agg(l) FROM jsonb_array_elements(regulatory->'legal') l
                             WHERE l->>'kind' IS DISTINCT FROM 'judgment'), '[]'::jsonb),
    'judiciary', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                             'id', l->'id', 'title', l->'title',
                             'court', COALESCE(l->'issued_by', to_jsonb('Verify: court not recorded'::text)),
                             'court_level', 'other', 'citation', l->'citation', 'decided_on', l->'effective_from',
                             'bench', '[]'::jsonb, 'holding', '', 'summary', COALESCE(l->'summary', to_jsonb(''::text)),
                             'interprets', '[]'::jsonb, 'status', 'good_law', 'url', l->'url', 'applies_to', l->'applies_to')))
                           FROM jsonb_array_elements(regulatory->'legal') l WHERE l->>'kind' = 'judgment'), '[]'::jsonb)))
  WHERE jsonb_typeof(regulatory->'legal') = 'array';
  CREATE TABLE IF NOT EXISTS financial_products.product_categories (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]*$'),
    name text NOT NULL,
    product_lines text[] NOT NULL,
    description text NOT NULL DEFAULT '',
    active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.audit_log (
    id uuid PRIMARY KEY,
    actor_id uuid REFERENCES financial_products.users(id),
    action text NOT NULL,
    target text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS audit_log_created_idx ON financial_products.audit_log (created_at DESC);
  -- Entities (licensed firms) and the licences they hold; admins verify licences.
  CREATE TABLE IF NOT EXISTS financial_products.entities (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    registration_numbers jsonb NOT NULL DEFAULT '{}',
    regions text[] NOT NULL DEFAULT '{}',
    created_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE financial_products.users ADD COLUMN IF NOT EXISTS entity_id uuid REFERENCES financial_products.entities(id);
  CREATE TABLE IF NOT EXISTS financial_products.held_licenses (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    region text NOT NULL,
    regulator_id text NOT NULL,
    license_id text NOT NULL,
    registration_number text NOT NULL,
    valid_from text,
    valid_to text,
    status text NOT NULL CHECK (status IN ('pending', 'verified', 'rejected', 'suspended')),
    submitted_by uuid REFERENCES financial_products.users(id),
    reviewed_by uuid REFERENCES financial_products.users(id),
    review_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    UNIQUE (entity_id, region, regulator_id, license_id)
  );
  -- Products: who issues or distributes them, what they build on, and how developers may use them.
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS entity_id uuid REFERENCES financial_products.entities(id);
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'issuance';
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS underlying_product_ids text[] NOT NULL DEFAULT '{}';
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'approval';
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS build_terms jsonb NOT NULL DEFAULT '{}';
  ALTER TABLE financial_products.apps ADD COLUMN IF NOT EXISTS disclosures text[] NOT NULL DEFAULT '{}';
  ALTER TABLE financial_products.apps ADD COLUMN IF NOT EXISTS actions text[] NOT NULL DEFAULT '{display}';
  -- Campaigns over other innovators' products wait for their approval.
  ALTER TABLE financial_products.campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
  ALTER TABLE financial_products.campaigns ADD CONSTRAINT campaigns_status_check
    CHECK (status IN ('draft', 'pending_approval', 'live', 'paused', 'ended'));
  -- Developers' requests to build on a product, and to launch campaigns over it.
  CREATE TABLE IF NOT EXISTS financial_products.requests (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('product_access', 'campaign_launch')),
    product_id text NOT NULL REFERENCES financial_products.products(id),
    app_id uuid REFERENCES financial_products.apps(id),
    campaign_id uuid REFERENCES financial_products.campaigns(id),
    requester_id uuid NOT NULL REFERENCES financial_products.users(id),
    status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
    note text NOT NULL DEFAULT '',
    decision_note text,
    decided_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS requests_product_idx ON financial_products.requests (product_id, status);
  -- SDKs and experiences (developer build layer).
  ALTER TABLE financial_products.apps ADD COLUMN IF NOT EXISTS experience jsonb;
  CREATE TABLE IF NOT EXISTS financial_products.sdks (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES financial_products.users(id),
    name text NOT NULL,
    languages text[] NOT NULL,
    product_ids text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS sdks_owner_idx ON financial_products.sdks (owner_id);
  CREATE TABLE IF NOT EXISTS financial_products.sdk_releases (
    sdk_id uuid NOT NULL REFERENCES financial_products.sdks(id),
    version text NOT NULL,
    changelog text NOT NULL,
    sources jsonb NOT NULL,
    files jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sdk_id, version)
  );
  -- Releases are immutable: a published bundle never changes under its version.
  CREATE OR REPLACE FUNCTION financial_products.sdk_releases_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'SDK releases are immutable';
  END $$;
  DROP TRIGGER IF EXISTS sdk_releases_immutable ON financial_products.sdk_releases;
  CREATE TRIGGER sdk_releases_immutable BEFORE UPDATE ON financial_products.sdk_releases
    FOR EACH ROW EXECUTE FUNCTION financial_products.sdk_releases_immutable();
  -- end SDKs and experiences
`;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

type Row = Record<string, unknown>;

const toUser = (r: Row): User => ({
  id: r.id as string,
  name: r.name as string,
  roles: r.roles as Role[],
  email: (r.email as string | null) ?? null,
  entity_id: (r.entity_id as string | null) ?? null,
  created_at: iso(r.created_at)!,
});

const toInvite = (r: Row): Invite => ({ email: r.email as string, roles: r.roles as Role[], created_at: iso(r.created_at)! });

const toProductRecord = (r: Row): ProductRecord => ({
  product: r.data as FinancialProduct,
  owner_id: r.owner_id as string | null,
  status: r.status as ProductStatus,
  version: Number(r.version ?? 1),
  last_test: (r.last_test as TestReport | null) ?? null,
  entity_id: (r.entity_id as string | null) ?? null,
  action: ((r.action as string) ?? "issuance") as ProductAction,
  underlying_product_ids: (r.underlying_product_ids as string[]) ?? [],
  // The bundled reference catalogue is open to every developer.
  access_mode: (r.owner_id == null ? "open" : ((r.access_mode as string) ?? "approval")) as AccessMode,
  build_terms: (r.build_terms as BuildTerms) ?? {},
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
  published_at: iso(r.published_at),
});

const toEntity = (r: Row): Entity => ({
  id: r.id as string,
  name: r.name as string,
  registration_numbers: (r.registration_numbers as Record<string, string>) ?? {},
  regions: (r.regions as string[]) ?? [],
  created_by: (r.created_by as string | null) ?? null,
  created_at: iso(r.created_at)!,
});

const toHeldLicense = (r: Row): HeldLicense => ({
  id: r.id as string,
  entity_id: r.entity_id as string,
  region: r.region as string,
  regulator_id: r.regulator_id as string,
  license_id: r.license_id as string,
  registration_number: r.registration_number as string,
  valid_from: (r.valid_from as string | null) ?? null,
  valid_to: (r.valid_to as string | null) ?? null,
  status: r.status as LicenseStatus,
  submitted_by: (r.submitted_by as string | null) ?? null,
  reviewed_by: (r.reviewed_by as string | null) ?? null,
  review_note: (r.review_note as string | null) ?? null,
  created_at: iso(r.created_at)!,
  reviewed_at: iso(r.reviewed_at),
});

const toRequest = (r: Row): AccessRequest => ({
  id: r.id as string,
  kind: r.kind as RequestKind,
  product_id: r.product_id as string,
  app_id: (r.app_id as string | null) ?? null,
  campaign_id: (r.campaign_id as string | null) ?? null,
  requester_id: r.requester_id as string,
  status: r.status as RequestStatus,
  note: (r.note as string) ?? "",
  decision_note: (r.decision_note as string | null) ?? null,
  decided_by: (r.decided_by as string | null) ?? null,
  created_at: iso(r.created_at)!,
  decided_at: iso(r.decided_at),
});

const toProductVersion = (r: Row): ProductVersion => ({
  product_id: r.product_id as string,
  version: Number(r.version),
  status: r.status as ProductVersion["status"],
  data: r.data as FinancialProduct,
  changelog: r.changelog as string,
  last_test: (r.last_test as TestReport | null) ?? null,
  created_at: iso(r.created_at)!,
  published_at: iso(r.published_at),
});

const toEnrollment = (r: Row): Enrollment => ({
  id: r.id as string,
  user_id: r.user_id as string,
  product_id: r.product_id as string,
  product_version: Number(r.product_version ?? 1),
  amount: r.amount == null ? null : Number(r.amount),
  status: r.status as Enrollment["status"],
  campaign_id: (r.campaign_id as string | null) ?? null,
  variant: (r.variant as string | null) ?? null,
  created_at: iso(r.created_at)!,
});

const toSegment = (r: Row): Segment => ({
  id: r.id as string,
  owner_id: r.owner_id as string,
  name: r.name as string,
  criteria: r.criteria as SegmentCriteria,
  created_at: iso(r.created_at)!,
});

const toCampaign = (r: Row): Campaign => ({
  id: r.id as string,
  owner_id: r.owner_id as string,
  name: r.name as string,
  product_ids: r.product_ids as string[],
  segment_id: (r.segment_id as string | null) ?? null,
  channels: r.channels as string[],
  variants: r.variants as Variant[],
  status: r.status as CampaignStatus,
  last_lint: r.last_lint ?? null,
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
  launched_at: iso(r.launched_at),
});

const toApp = (r: Row): App => ({
  id: r.id as string,
  owner_id: r.owner_id as string,
  name: r.name as string,
  description: r.description as string,
  audience: r.audience as string,
  product_ids: r.product_ids as string[],
  disclosures: (r.disclosures as string[]) ?? [],
  actions: (r.actions as string[]) ?? ["display"],
  status: r.status as App["status"],
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
});

// --- SDKs and experiences (developer build layer) ---
const toSdk = (r: Row): Sdk => ({
  id: r.id as string,
  owner_id: r.owner_id as string,
  name: r.name as string,
  languages: r.languages as string[],
  product_ids: r.product_ids as string[],
  created_at: iso(r.created_at)!,
});

const toSdkRelease = (r: Row): SdkRelease => ({
  sdk_id: r.sdk_id as string,
  version: r.version as string,
  changelog: r.changelog as string,
  sources: r.sources as SdkReleaseSource[],
  files: r.files as SdkRelease["files"],
  created_at: iso(r.created_at)!,
});
// --- end SDKs and experiences ---

export class Store {
  private constructor(private readonly db: Db) {}

  // Creates the schema if needed and seeds the bundled catalog as published, read-only products.
  // A least-privilege role can own a pre-created schema without database-level CREATE rights,
  // and CREATE SCHEMA IF NOT EXISTS would still demand them, so only create it when missing.
  static async open(db: Db, seed: FinancialProduct[] = loadCatalog()): Promise<Store> {
    const { rows } = await db.query("SELECT 1 FROM pg_namespace WHERE nspname = 'financial_products'");
    if (rows.length === 0) await db.exec("CREATE SCHEMA financial_products");
    await db.exec(TABLES);
    await db.query(
      `INSERT INTO financial_products.products (id, owner_id, status, data, published_at)
       SELECT p->>'id', NULL, 'published', p, now() FROM jsonb_array_elements($1::jsonb) AS p
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(seed)],
    );
    // Seed reference data once; after that admins own it (existing rows are never overwritten).
    const ref = referenceSeed(seed);
    await db.query(
      `INSERT INTO financial_products.regions (code, name, regulators)
       SELECT r->>'code', r->>'name', ARRAY(SELECT jsonb_array_elements_text(r->'regulators')) FROM jsonb_array_elements($1::jsonb) AS r
       ON CONFLICT (code) DO NOTHING`,
      [JSON.stringify(ref.regions)],
    );
    await db.query(
      `INSERT INTO financial_products.product_categories (id, name, product_lines)
       SELECT c->>'id', c->>'name', ARRAY(SELECT jsonb_array_elements_text(c->'product_lines')) FROM jsonb_array_elements($1::jsonb) AS c
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(ref.categories)],
    );
    return new Store(db);
  }

  // Reference data

  async referenceData(includeInactive = false): Promise<ReferenceData> {
    const where = includeInactive ? "" : "WHERE active";
    const [regions, categories] = await Promise.all([
      this.all(`SELECT * FROM financial_products.regions ${where} ORDER BY code = 'global' DESC, code`),
      this.all(`SELECT * FROM financial_products.product_categories ${where} ORDER BY id`),
    ]);
    return {
      regions: regions.map((r) => ({ ...(r as unknown as Region), updated_at: iso(r.updated_at)! })),
      categories: categories.map((c) => ({ ...(c as unknown as ProductCategory), updated_at: iso(c.updated_at)! })),
    };
  }

  async upsertRegion(r: RegionUpdate): Promise<Region> {
    const row = await this.one(
      `INSERT INTO financial_products.regions (code, name, regulators, ecosystem, procedures, sources, active)
       VALUES ($1, COALESCE($2::text, $1), COALESCE($3::text[], '{}'::text[]), COALESCE($4::text, ''), COALESCE($5::jsonb, '[]'::jsonb),
               COALESCE($6::text[], '{}'::text[]), COALESCE($7::boolean, true))
       ON CONFLICT (code) DO UPDATE SET
         name = COALESCE($2::text, regions.name), regulators = COALESCE($3::text[], regions.regulators),
         ecosystem = COALESCE($4::text, regions.ecosystem), procedures = COALESCE($5::jsonb, regions.procedures),
         sources = COALESCE($6::text[], regions.sources), active = COALESCE($7::boolean, regions.active), updated_at = now()
       RETURNING *`,
      [
        r.code,
        r.name ?? null,
        r.regulators ?? null,
        r.ecosystem ?? null,
        r.procedures ? JSON.stringify(r.procedures) : null,
        r.sources ?? null,
        r.active ?? null,
      ],
    );
    return { ...(row as unknown as Region), updated_at: iso(row!.updated_at)! };
  }

  async setRegulatoryModel(code: string, model: RegulatoryModel): Promise<void> {
    await this.db.query("UPDATE financial_products.regions SET regulatory = $2, updated_at = now() WHERE code = $1", [code, JSON.stringify(model)]);
  }

  async upsertCategory(c: Omit<ProductCategory, "updated_at">): Promise<ProductCategory> {
    const row = await this.one(
      `INSERT INTO financial_products.product_categories (id, name, product_lines, description, active) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, product_lines = EXCLUDED.product_lines,
         description = EXCLUDED.description, active = EXCLUDED.active, updated_at = now()
       RETURNING *`,
      [c.id, c.name, c.product_lines, c.description, c.active],
    );
    return { ...(row as unknown as ProductCategory), updated_at: iso(row!.updated_at)! };
  }

  // Audit log

  async audit(actorId: string | null, action: string, target: string, details: unknown = {}): Promise<void> {
    await this.db.query(
      "INSERT INTO financial_products.audit_log (id, actor_id, action, target, details) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), actorId, action, target, JSON.stringify(details)],
    );
  }

  async auditLog(limit = 100): Promise<AuditEntry[]> {
    const rows = await this.all(
      `SELECT a.*, u.email AS actor_email FROM financial_products.audit_log a
       LEFT JOIN financial_products.users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id as string,
      actor_id: (r.actor_id as string | null) ?? null,
      actor_email: (r.actor_email as string | null) ?? null,
      action: r.action as string,
      target: r.target as string,
      details: r.details,
      created_at: iso(r.created_at)!,
    }));
  }

  async allCampaigns(): Promise<Campaign[]> {
    return (await this.all("SELECT * FROM financial_products.campaigns ORDER BY created_at DESC")).map(toCampaign);
  }

  close(): Promise<void> {
    return this.db.close();
  }

  async ping(): Promise<void> {
    await this.db.query("SELECT 1");
  }

  private async one(sql: string, params: unknown[]): Promise<Row | undefined> {
    return (await this.db.query(sql, params)).rows[0];
  }

  private async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.db.query(sql, params)).rows;
  }

  // Users

  async createUser(name: string, roles: Role[]): Promise<{ user: User; token: string }> {
    const token = `fpm_${randomBytes(24).toString("base64url")}`;
    const r = await this.one(
      "INSERT INTO financial_products.users (id, name, roles, token_hash) VALUES ($1, $2, $3, $4) RETURNING *",
      [randomUUID(), name, roles, hashToken(token)],
    );
    return { user: toUser(r!), token };
  }

  async userByToken(token: string): Promise<User | undefined> {
    const r = await this.one("SELECT * FROM financial_products.users WHERE token_hash = $1", [hashToken(token)]);
    return r && toUser(r);
  }

  async listUsers(): Promise<User[]> {
    return (await this.all("SELECT * FROM financial_products.users ORDER BY created_at")).map(toUser);
  }

  async clerkIdForEmail(email: string): Promise<string | null> {
    const r = await this.one("SELECT clerk_user_id FROM financial_products.users WHERE email = $1", [email.toLowerCase()]);
    return (r?.clerk_user_id as string | null | undefined) ?? null;
  }

  async userByClerkId(clerkUserId: string): Promise<User | undefined> {
    const r = await this.one("SELECT * FROM financial_products.users WHERE clerk_user_id = $1", [clerkUserId]);
    return r && toUser(r);
  }

  // Creates or refreshes the user linked to a Clerk account. Roles always come from the invite.
  // A known verified email with a new Clerk id (e.g. after moving to a production Clerk instance)
  // relinks the existing user, so they keep what they own.
  async upsertClerkUser(clerkUserId: string, email: string, name: string, roles: Role[]): Promise<User> {
    const lower = email.toLowerCase();
    const updated = await this.one(
      `UPDATE financial_products.users SET clerk_user_id = $1, email = $2, roles = $3
       WHERE id = (SELECT id FROM financial_products.users WHERE clerk_user_id = $1 OR email = $2
                   ORDER BY (clerk_user_id = $1) DESC NULLS LAST LIMIT 1)
       RETURNING *`,
      [clerkUserId, lower, roles],
    );
    if (updated) return toUser(updated);
    const r = await this.one(
      "INSERT INTO financial_products.users (id, name, roles, clerk_user_id, email) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [randomUUID(), name, roles, clerkUserId, lower],
    );
    return toUser(r!);
  }

  // Whitelist

  async upsertInvite(email: string, roles: Role[]): Promise<Invite> {
    const r = await this.one(
      `INSERT INTO financial_products.invites (email, roles) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET roles = EXCLUDED.roles RETURNING *`,
      [email.toLowerCase(), roles],
    );
    return toInvite(r!);
  }

  async getInvite(email: string): Promise<Invite | undefined> {
    const r = await this.one("SELECT * FROM financial_products.invites WHERE email = $1", [email.toLowerCase()]);
    return r && toInvite(r);
  }

  async deleteInvite(email: string): Promise<boolean> {
    return (await this.all("DELETE FROM financial_products.invites WHERE email = $1 RETURNING email", [email.toLowerCase()])).length > 0;
  }

  async listInvites(): Promise<Invite[]> {
    return (await this.all("SELECT * FROM financial_products.invites ORDER BY created_at")).map(toInvite);
  }

  // Products

  async getProduct(id: string): Promise<ProductRecord | undefined> {
    const r = await this.one("SELECT * FROM financial_products.products WHERE id = $1", [id]);
    return r && toProductRecord(r);
  }

  async publishedProducts(): Promise<FinancialProduct[]> {
    const rows = await this.all("SELECT * FROM financial_products.products WHERE status = 'published' ORDER BY published_at, id");
    return rows.map((r) => toProductRecord(r).product);
  }

  async productsByOwner(ownerId: string): Promise<ProductRecord[]> {
    return (await this.all("SELECT * FROM financial_products.products WHERE owner_id = $1 ORDER BY created_at", [ownerId])).map(
      toProductRecord,
    );
  }

  async insertDraft(
    ownerId: string,
    p: FinancialProduct,
    meta: { entity_id?: string | null; action?: ProductAction; underlying_product_ids?: string[] } = {},
  ): Promise<ProductRecord> {
    try {
      const r = await this.one(
        `INSERT INTO financial_products.products (id, owner_id, status, data, entity_id, action, underlying_product_ids)
         VALUES ($1, $2, 'draft', $3, $4, $5, $6) RETURNING *`,
        [p.id, ownerId, JSON.stringify(p), meta.entity_id ?? null, meta.action ?? "issuance", meta.underlying_product_ids ?? []],
      );
      return toProductRecord(r!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError(`Product id '${p.id}' is taken`);
      throw e;
    }
  }

  async saveProduct(p: FinancialProduct, status: ProductStatus): Promise<ProductRecord> {
    const r = await this.one(
      "UPDATE financial_products.products SET data = $1, status = $2, updated_at = now() WHERE id = $3 RETURNING *",
      [JSON.stringify(p), status, p.id],
    );
    return toProductRecord(r!);
  }

  async saveTestReport(id: string, report: TestReport): Promise<void> {
    await this.db.query("UPDATE financial_products.products SET last_test = $1 WHERE id = $2", [JSON.stringify(report), id]);
  }

  async setProductStatus(id: string, status: ProductStatus): Promise<ProductRecord> {
    const r = await this.one(
      `UPDATE financial_products.products
       SET status = $1, updated_at = now(), published_at = CASE WHEN $1 = 'published' THEN now() ELSE published_at END
       WHERE id = $2 RETURNING *`,
      [status, id],
    );
    return toProductRecord(r!);
  }

  // Publishes the product's current data as its current version and records it in the history
  // (one statement, so the history and the live product never disagree).
  async publishCurrentVersion(id: string): Promise<ProductRecord> {
    const r = await this.one(
      `WITH p AS (
         UPDATE financial_products.products SET status = 'published', updated_at = now(), published_at = now()
         WHERE id = $1 RETURNING *
       ), sup AS (
         UPDATE financial_products.product_versions SET status = 'superseded'
         WHERE product_id = $1 AND status = 'published' AND version <> (SELECT version FROM p)
       ), ins AS (
         INSERT INTO financial_products.product_versions (product_id, version, status, data, changelog, last_test, published_at)
         SELECT id, version, 'published', data, 'Initial release', last_test, now() FROM p
         ON CONFLICT (product_id, version) DO UPDATE
           SET status = 'published', data = EXCLUDED.data, last_test = EXCLUDED.last_test, published_at = now()
       )
       SELECT * FROM p`,
      [id],
    );
    return toProductRecord(r!);
  }

  // Versions

  async productVersions(id: string): Promise<ProductVersion[]> {
    return (await this.all("SELECT * FROM financial_products.product_versions WHERE product_id = $1 ORDER BY version", [id])).map(
      toProductVersion,
    );
  }

  async draftVersion(id: string): Promise<ProductVersion | undefined> {
    const r = await this.one("SELECT * FROM financial_products.product_versions WHERE product_id = $1 AND status = 'draft'", [id]);
    return r && toProductVersion(r);
  }

  async createDraftVersion(id: string, data: FinancialProduct, changelog: string): Promise<ProductVersion> {
    try {
      const r = await this.one(
        `INSERT INTO financial_products.product_versions (product_id, version, status, data, changelog)
         SELECT $1, GREATEST(p.version, COALESCE(MAX(v.version), 0)) + 1, 'draft', $2, $3
         FROM financial_products.products p LEFT JOIN financial_products.product_versions v ON v.product_id = p.id
         WHERE p.id = $1 GROUP BY p.version
         RETURNING *`,
        [id, JSON.stringify(data), changelog],
      );
      return toProductVersion(r!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError(`'${id}' already has a draft version; update, test and publish it first`);
      throw e;
    }
  }

  async saveDraftVersion(id: string, data: FinancialProduct, changelog: string): Promise<ProductVersion> {
    const r = await this.one(
      `UPDATE financial_products.product_versions SET data = $2, changelog = $3, last_test = NULL
       WHERE product_id = $1 AND status = 'draft' RETURNING *`,
      [id, JSON.stringify(data), changelog],
    );
    return toProductVersion(r!);
  }

  async saveDraftVersionTest(id: string, report: TestReport): Promise<void> {
    await this.db.query("UPDATE financial_products.product_versions SET last_test = $2 WHERE product_id = $1 AND status = 'draft'", [
      id,
      JSON.stringify(report),
    ]);
  }

  // The draft version becomes the live product; the previous live version is superseded.
  async publishDraftVersion(id: string): Promise<ProductRecord> {
    const r = await this.one(
      `WITH d AS (
         SELECT * FROM financial_products.product_versions WHERE product_id = $1 AND status = 'draft'
       ), sup AS (
         UPDATE financial_products.product_versions SET status = 'superseded'
         WHERE product_id = $1 AND status = 'published' AND EXISTS (SELECT 1 FROM d)
       ), pub AS (
         UPDATE financial_products.product_versions v SET status = 'published', published_at = now()
         FROM d WHERE v.product_id = d.product_id AND v.version = d.version RETURNING v.*
       )
       UPDATE financial_products.products p
       SET data = pub.data, version = pub.version, last_test = pub.last_test, status = 'published', updated_at = now(), published_at = now()
       FROM pub WHERE p.id = pub.product_id RETURNING p.*`,
      [id],
    );
    return toProductRecord(r!);
  }

  async upgradeEnrollments(productId: string, enrollmentId?: string): Promise<number> {
    const rows = await this.all(
      `UPDATE financial_products.enrollments e SET product_version = p.version
       FROM financial_products.products p
       WHERE e.product_id = p.id AND p.id = $1 AND e.status = 'active' AND e.product_version < p.version
         AND ($2::text IS NULL OR e.id::text = $2)
       RETURNING e.id`,
      [productId, enrollmentId ?? null],
    );
    return rows.length;
  }

  // Enrollments

  async createEnrollment(
    userId: string,
    productId: string,
    amount: number | null,
    attribution: { campaign_id: string; variant: string } | null = null,
  ): Promise<Enrollment> {
    try {
      const r = await this.one(
        `INSERT INTO financial_products.enrollments (id, user_id, product_id, product_version, amount, status, campaign_id, variant)
         SELECT $1, $2, $3, p.version, $4, 'active', $5, $6 FROM financial_products.products p WHERE p.id = $3
         RETURNING *`,
        [randomUUID(), userId, productId, amount, attribution?.campaign_id ?? null, attribution?.variant ?? null],
      );
      return toEnrollment(r!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError(`Already enrolled in '${productId}'`);
      throw e;
    }
  }

  // Active enrollments with their product line, for segment matching.
  async activeEnrollmentFacts(): Promise<{ user_id: string; product_id: string; product_line: string }[]> {
    return (await this.all(
      `SELECT e.user_id, e.product_id, p.data->>'product_line' AS product_line
       FROM financial_products.enrollments e JOIN financial_products.products p ON p.id = e.product_id
       WHERE e.status = 'active'`,
    )) as { user_id: string; product_id: string; product_line: string }[];
  }

  async campaignEnrollments(campaignId: string): Promise<Enrollment[]> {
    return (await this.all("SELECT * FROM financial_products.enrollments WHERE campaign_id::text = $1", [campaignId])).map(toEnrollment);
  }

  // Segments and campaigns

  async createSegment(ownerId: string, name: string, criteria: SegmentCriteria): Promise<Segment> {
    const r = await this.one(
      "INSERT INTO financial_products.segments (id, owner_id, name, criteria) VALUES ($1, $2, $3, $4) RETURNING *",
      [randomUUID(), ownerId, name, JSON.stringify(criteria)],
    );
    return toSegment(r!);
  }

  async getSegment(id: string): Promise<Segment | undefined> {
    const r = await this.one("SELECT * FROM financial_products.segments WHERE id::text = $1", [id]);
    return r && toSegment(r);
  }

  async segmentsByOwner(ownerId: string): Promise<Segment[]> {
    return (await this.all("SELECT * FROM financial_products.segments WHERE owner_id = $1 ORDER BY created_at", [ownerId])).map(toSegment);
  }

  async createCampaign(
    ownerId: string,
    c: Pick<Campaign, "name" | "product_ids" | "segment_id" | "channels" | "variants">,
  ): Promise<Campaign> {
    const r = await this.one(
      `INSERT INTO financial_products.campaigns (id, owner_id, name, product_ids, segment_id, channels, variants, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft') RETURNING *`,
      [randomUUID(), ownerId, c.name, c.product_ids, c.segment_id, c.channels, JSON.stringify(c.variants)],
    );
    return toCampaign(r!);
  }

  async getCampaign(id: string): Promise<Campaign | undefined> {
    const r = await this.one("SELECT * FROM financial_products.campaigns WHERE id::text = $1", [id]);
    return r && toCampaign(r);
  }

  async saveCampaign(c: Campaign): Promise<Campaign> {
    const r = await this.one(
      `UPDATE financial_products.campaigns
       SET name = $2, product_ids = $3, segment_id = $4, channels = $5, variants = $6, status = $7, last_lint = $8,
           updated_at = now(), launched_at = CASE WHEN $7 = 'live' AND launched_at IS NULL THEN now() ELSE launched_at END
       WHERE id = $1 RETURNING *`,
      [c.id, c.name, c.product_ids, c.segment_id, c.channels, JSON.stringify(c.variants), c.status, JSON.stringify(c.last_lint)],
    );
    return toCampaign(r!);
  }

  async campaignsByOwner(ownerId: string): Promise<Campaign[]> {
    return (await this.all("SELECT * FROM financial_products.campaigns WHERE owner_id = $1 ORDER BY created_at", [ownerId])).map(
      toCampaign,
    );
  }

  async liveCampaigns(): Promise<Campaign[]> {
    return (await this.all("SELECT * FROM financial_products.campaigns WHERE status = 'live' ORDER BY launched_at")).map(toCampaign);
  }

  async enrollmentsByUser(userId: string): Promise<Enrollment[]> {
    return (await this.all("SELECT * FROM financial_products.enrollments WHERE user_id = $1 ORDER BY created_at", [userId])).map(
      toEnrollment,
    );
  }

  async getEnrollment(id: string): Promise<Enrollment | undefined> {
    const r = await this.one("SELECT * FROM financial_products.enrollments WHERE id::text = $1", [id]);
    return r && toEnrollment(r);
  }

  async cancelEnrollment(id: string): Promise<Enrollment> {
    const r = await this.one("UPDATE financial_products.enrollments SET status = 'cancelled' WHERE id::text = $1 RETURNING *", [id]);
    return toEnrollment(r!);
  }

  // Apps

  async createApp(
    ownerId: string,
    fields: Pick<App, "name" | "description" | "audience" | "product_ids"> & Partial<Pick<App, "disclosures" | "actions">>,
  ): Promise<App> {
    const r = await this.one(
      `INSERT INTO financial_products.apps (id, owner_id, name, description, audience, product_ids, status, disclosures, actions)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8) RETURNING *`,
      [randomUUID(), ownerId, fields.name, fields.description, fields.audience, fields.product_ids, fields.disclosures ?? [], fields.actions ?? ["display"]],
    );
    return toApp(r!);
  }

  async getApp(id: string): Promise<App | undefined> {
    const r = await this.one("SELECT * FROM financial_products.apps WHERE id::text = $1", [id]);
    return r && toApp(r);
  }

  async saveApp(app: App): Promise<App> {
    const r = await this.one(
      `UPDATE financial_products.apps
       SET name = $1, description = $2, audience = $3, product_ids = $4, status = $5, disclosures = $7, actions = $8, updated_at = now()
       WHERE id = $6 RETURNING *`,
      [app.name, app.description, app.audience, app.product_ids, app.status, app.id, app.disclosures, app.actions],
    );
    return toApp(r!);
  }

  async appsByOwner(ownerId: string): Promise<App[]> {
    return (await this.all("SELECT * FROM financial_products.apps WHERE owner_id = $1 ORDER BY created_at", [ownerId])).map(toApp);
  }


  async allApps(): Promise<App[]> {
    return (await this.all("SELECT * FROM financial_products.apps ORDER BY created_at")).map(toApp);
  }

  // Entities and held licences

  async createEntity(createdBy: string, e: Pick<Entity, "name" | "registration_numbers" | "regions">): Promise<Entity> {
    const r = await this.one(
      "INSERT INTO financial_products.entities (id, name, registration_numbers, regions, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [randomUUID(), e.name, JSON.stringify(e.registration_numbers), e.regions, createdBy],
    );
    return toEntity(r!);
  }

  async getEntity(id: string): Promise<Entity | undefined> {
    const r = await this.one("SELECT * FROM financial_products.entities WHERE id::text = $1", [id]);
    return r && toEntity(r);
  }

  async listEntities(): Promise<Entity[]> {
    return (await this.all("SELECT * FROM financial_products.entities ORDER BY created_at")).map(toEntity);
  }

  async setUserEntity(userId: string, entityId: string | null): Promise<void> {
    await this.db.query("UPDATE financial_products.users SET entity_id = $2 WHERE id = $1", [userId, entityId]);
  }

  async userByEmail(email: string): Promise<User | undefined> {
    const r = await this.one("SELECT * FROM financial_products.users WHERE email = $1", [email.toLowerCase()]);
    return r && toUser(r);
  }

  async getUser(id: string): Promise<User | undefined> {
    const r = await this.one("SELECT * FROM financial_products.users WHERE id::text = $1", [id]);
    return r && toUser(r);
  }

  async entityMembers(entityId: string): Promise<User[]> {
    return (await this.all("SELECT * FROM financial_products.users WHERE entity_id = $1 ORDER BY created_at", [entityId])).map(toUser);
  }

  async registerLicense(
    submittedBy: string,
    l: Pick<HeldLicense, "entity_id" | "region" | "regulator_id" | "license_id" | "registration_number" | "valid_from" | "valid_to">,
  ): Promise<HeldLicense> {
    // Re-registering resubmits for review.
    const r = await this.one(
      `INSERT INTO financial_products.held_licenses
         (id, entity_id, region, regulator_id, license_id, registration_number, valid_from, valid_to, status, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
       ON CONFLICT (entity_id, region, regulator_id, license_id) DO UPDATE SET
         registration_number = EXCLUDED.registration_number, valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
         status = 'pending', submitted_by = EXCLUDED.submitted_by, reviewed_by = NULL, review_note = NULL, reviewed_at = NULL
       RETURNING *`,
      [randomUUID(), l.entity_id, l.region, l.regulator_id, l.license_id, l.registration_number, l.valid_from, l.valid_to, submittedBy],
    );
    return toHeldLicense(r!);
  }

  async getHeldLicense(id: string): Promise<HeldLicense | undefined> {
    const r = await this.one("SELECT * FROM financial_products.held_licenses WHERE id::text = $1", [id]);
    return r && toHeldLicense(r);
  }

  async licensesOf(entityId: string): Promise<HeldLicense[]> {
    return (await this.all("SELECT * FROM financial_products.held_licenses WHERE entity_id = $1 ORDER BY created_at", [entityId])).map(toHeldLicense);
  }

  async licensesByStatus(status?: LicenseStatus): Promise<HeldLicense[]> {
    const rows = status
      ? await this.all("SELECT * FROM financial_products.held_licenses WHERE status = $1 ORDER BY created_at", [status])
      : await this.all("SELECT * FROM financial_products.held_licenses ORDER BY created_at");
    return rows.map(toHeldLicense);
  }

  async reviewLicense(id: string, status: LicenseStatus, reviewerId: string, note: string | null): Promise<HeldLicense> {
    const r = await this.one(
      `UPDATE financial_products.held_licenses SET status = $2, reviewed_by = $3, review_note = $4, reviewed_at = now()
       WHERE id::text = $1 RETURNING *`,
      [id, status, reviewerId, note],
    );
    return toHeldLicense(r!);
  }

  // Product access

  async setProductAccess(id: string, mode: AccessMode, terms: BuildTerms): Promise<ProductRecord> {
    const r = await this.one(
      "UPDATE financial_products.products SET access_mode = $2, build_terms = $3, updated_at = now() WHERE id = $1 RETURNING *",
      [id, mode, JSON.stringify(terms)],
    );
    return toProductRecord(r!);
  }

  async createRequest(
    req: Pick<AccessRequest, "kind" | "product_id" | "app_id" | "campaign_id" | "requester_id" | "status" | "note"> & { decided_by?: string | null },
  ): Promise<AccessRequest> {
    const r = await this.one(
      `INSERT INTO financial_products.requests (id, kind, product_id, app_id, campaign_id, requester_id, status, note, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $7 = 'pending' THEN NULL ELSE now() END) RETURNING *`,
      [randomUUID(), req.kind, req.product_id, req.app_id, req.campaign_id, req.requester_id, req.status, req.note, req.decided_by ?? null],
    );
    return toRequest(r!);
  }

  async getRequest(id: string): Promise<AccessRequest | undefined> {
    const r = await this.one("SELECT * FROM financial_products.requests WHERE id::text = $1", [id]);
    return r && toRequest(r);
  }

  async decideRequest(id: string, status: RequestStatus, deciderId: string, note: string | null): Promise<AccessRequest> {
    const r = await this.one(
      `UPDATE financial_products.requests SET status = $2, decided_by = $3, decision_note = $4, decided_at = now()
       WHERE id::text = $1 RETURNING *`,
      [id, status, deciderId, note],
    );
    return toRequest(r!);
  }

  async requestsForProducts(productIds: string[]): Promise<AccessRequest[]> {
    if (productIds.length === 0) return [];
    return (
      await this.all("SELECT * FROM financial_products.requests WHERE product_id = ANY($1) ORDER BY created_at DESC", [productIds])
    ).map(toRequest);
  }

  async requestsBy(requesterId: string): Promise<AccessRequest[]> {
    return (await this.all("SELECT * FROM financial_products.requests WHERE requester_id = $1 ORDER BY created_at DESC", [requesterId])).map(toRequest);
  }

  async requestsForCampaign(campaignId: string): Promise<AccessRequest[]> {
    return (await this.all("SELECT * FROM financial_products.requests WHERE campaign_id::text = $1 ORDER BY created_at", [campaignId])).map(toRequest);
  }

  async publishedApps(): Promise<App[]> {
    return (await this.all("SELECT * FROM financial_products.apps WHERE status = 'published' ORDER BY created_at")).map(toApp);
  }

  // --- SDKs and experiences (developer build layer) ---

  async appExperience(appId: string): Promise<unknown | null> {
    const r = await this.one("SELECT experience FROM financial_products.apps WHERE id::text = $1", [appId]);
    return (r?.experience as unknown) ?? null;
  }

  async setAppExperience(appId: string, experience: unknown): Promise<void> {
    await this.db.query("UPDATE financial_products.apps SET experience = $2, updated_at = now() WHERE id::text = $1", [
      appId,
      experience == null ? null : JSON.stringify(experience),
    ]);
  }

  async createSdk(ownerId: string, fields: Pick<Sdk, "name" | "languages" | "product_ids">): Promise<Sdk> {
    const r = await this.one(
      "INSERT INTO financial_products.sdks (id, owner_id, name, languages, product_ids) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [randomUUID(), ownerId, fields.name, fields.languages, fields.product_ids],
    );
    return toSdk(r!);
  }

  async getSdk(id: string): Promise<Sdk | undefined> {
    const r = await this.one("SELECT * FROM financial_products.sdks WHERE id::text = $1", [id]);
    return r && toSdk(r);
  }

  async sdksByOwner(ownerId: string): Promise<Sdk[]> {
    return (await this.all("SELECT * FROM financial_products.sdks WHERE owner_id = $1 ORDER BY created_at", [ownerId])).map(toSdk);
  }

  async createSdkRelease(release: Omit<SdkRelease, "created_at">): Promise<SdkRelease> {
    try {
      const r = await this.one(
        `INSERT INTO financial_products.sdk_releases (sdk_id, version, changelog, sources, files)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [release.sdk_id, release.version, release.changelog, JSON.stringify(release.sources), JSON.stringify(release.files)],
      );
      return toSdkRelease(r!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError(`Release ${release.version} already exists`);
      throw e;
    }
  }

  // Newest first.
  async sdkReleases(sdkId: string): Promise<SdkRelease[]> {
    return (await this.all("SELECT * FROM financial_products.sdk_releases WHERE sdk_id::text = $1 ORDER BY created_at DESC", [sdkId])).map(
      toSdkRelease,
    );
  }

  // --- end SDKs and experiences ---
}
