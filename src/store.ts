import { createHash, randomBytes, randomUUID } from "node:crypto";
import { loadCatalog, type FinancialProduct } from "./catalog.js";
import type { Db } from "./db.js";
import type { TestReport } from "./product-tests.js";

export const ROLES = ["consumer", "developer", "innovator"] as const;
export type Role = (typeof ROLES)[number];

// Roles nest: every innovator is a developer, and every developer is a consumer.
const IMPLIES: Record<Role, Role[]> = { consumer: [], developer: ["consumer"], innovator: ["developer"] };

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
  last_test: TestReport | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface Enrollment {
  id: string;
  user_id: string;
  product_id: string;
  amount: number | null;
  status: "active" | "cancelled";
  created_at: string;
}

export interface App {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  audience: string;
  product_ids: string[];
  status: "draft" | "published";
  created_at: string;
  updated_at: string;
}

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
  created_at: iso(r.created_at)!,
});

const toInvite = (r: Row): Invite => ({ email: r.email as string, roles: r.roles as Role[], created_at: iso(r.created_at)! });

const toProductRecord = (r: Row): ProductRecord => ({
  product: r.data as FinancialProduct,
  owner_id: r.owner_id as string | null,
  status: r.status as ProductStatus,
  last_test: (r.last_test as TestReport | null) ?? null,
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
  published_at: iso(r.published_at),
});

const toEnrollment = (r: Row): Enrollment => ({
  id: r.id as string,
  user_id: r.user_id as string,
  product_id: r.product_id as string,
  amount: r.amount == null ? null : Number(r.amount),
  status: r.status as Enrollment["status"],
  created_at: iso(r.created_at)!,
});

const toApp = (r: Row): App => ({
  id: r.id as string,
  owner_id: r.owner_id as string,
  name: r.name as string,
  description: r.description as string,
  audience: r.audience as string,
  product_ids: r.product_ids as string[],
  status: r.status as App["status"],
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
});

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
    return new Store(db);
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

  async userByClerkId(clerkUserId: string): Promise<User | undefined> {
    const r = await this.one("SELECT * FROM financial_products.users WHERE clerk_user_id = $1", [clerkUserId]);
    return r && toUser(r);
  }

  // Creates or refreshes the user linked to a Clerk account. Roles always come from the invite.
  async upsertClerkUser(clerkUserId: string, email: string, name: string, roles: Role[]): Promise<User> {
    const r = await this.one(
      `INSERT INTO financial_products.users (id, name, roles, clerk_user_id, email) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (clerk_user_id) DO UPDATE SET roles = EXCLUDED.roles, email = EXCLUDED.email
       RETURNING *`,
      [randomUUID(), name, roles, clerkUserId, email.toLowerCase()],
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

  async insertDraft(ownerId: string, p: FinancialProduct): Promise<ProductRecord> {
    try {
      const r = await this.one(
        "INSERT INTO financial_products.products (id, owner_id, status, data) VALUES ($1, $2, 'draft', $3) RETURNING *",
        [p.id, ownerId, JSON.stringify(p)],
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

  // Enrollments

  async createEnrollment(userId: string, productId: string, amount: number | null): Promise<Enrollment> {
    try {
      const r = await this.one(
        "INSERT INTO financial_products.enrollments (id, user_id, product_id, amount, status) VALUES ($1, $2, $3, $4, 'active') RETURNING *",
        [randomUUID(), userId, productId, amount],
      );
      return toEnrollment(r!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError(`Already enrolled in '${productId}'`);
      throw e;
    }
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

  async createApp(ownerId: string, fields: Pick<App, "name" | "description" | "audience" | "product_ids">): Promise<App> {
    const r = await this.one(
      `INSERT INTO financial_products.apps (id, owner_id, name, description, audience, product_ids, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft') RETURNING *`,
      [randomUUID(), ownerId, fields.name, fields.description, fields.audience, fields.product_ids],
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
       SET name = $1, description = $2, audience = $3, product_ids = $4, status = $5, updated_at = now()
       WHERE id = $6 RETURNING *`,
      [app.name, app.description, app.audience, app.product_ids, app.status, app.id],
    );
    return toApp(r!);
  }

  async appsByOwner(ownerId: string): Promise<App[]> {
    return (await this.all("SELECT * FROM financial_products.apps WHERE owner_id = $1 ORDER BY created_at", [ownerId])).map(toApp);
  }

  async publishedApps(): Promise<App[]> {
    return (await this.all("SELECT * FROM financial_products.apps WHERE status = 'published' ORDER BY created_at")).map(toApp);
  }
}
