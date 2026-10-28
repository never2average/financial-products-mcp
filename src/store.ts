import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadCatalog, type FinancialProduct } from "./catalog.js";
import type { TestReport } from "./product-tests.js";

export const ROLES = ["consumer", "developer", "innovator"] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  name: string;
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

export const DEFAULT_DB_PATH = join(homedir(), ".financial-products-mcp", "db.sqlite");

const now = () => new Date().toISOString();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

type Row = Record<string, unknown>;

const toProductRecord = (r: Row): ProductRecord => ({
  product: JSON.parse(r.data as string),
  owner_id: r.owner_id as string | null,
  status: r.status as ProductStatus,
  last_test: r.last_test ? JSON.parse(r.last_test as string) : null,
  created_at: r.created_at as string,
  updated_at: r.updated_at as string,
  published_at: r.published_at as string | null,
});

const toApp = (r: Row): App => ({ ...(r as unknown as App), product_ids: JSON.parse(r.product_ids as string) });

export class Store {
  readonly db: DatabaseSync;

  constructor(path = process.env.FINANCIAL_PRODUCTS_DB ?? DEFAULT_DB_PATH, seed: FinancialProduct[] = loadCatalog()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        roles TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        owner_id TEXT REFERENCES users(id),
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        last_test TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_at TEXT
      );
      CREATE TABLE IF NOT EXISTS enrollments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        product_id TEXT NOT NULL REFERENCES products(id),
        amount REAL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        audience TEXT NOT NULL,
        product_ids TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO products (id, owner_id, status, data, created_at, updated_at, published_at) VALUES (?, NULL, 'published', ?, ?, ?, ?)",
    );
    const ts = now();
    for (const p of seed) insert.run(p.id, JSON.stringify(p), ts, ts, ts);
  }

  // Users

  createUser(name: string, roles: Role[]): { user: User; token: string } {
    const token = `fpm_${randomBytes(24).toString("base64url")}`;
    const user: User = { id: randomUUID(), name, roles, created_at: now() };
    this.db
      .prepare("INSERT INTO users (id, name, roles, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, name, JSON.stringify(roles), hashToken(token), user.created_at);
    return { user, token };
  }

  userByToken(token: string): User | undefined {
    const r = this.db.prepare("SELECT id, name, roles, created_at FROM users WHERE token_hash = ?").get(hashToken(token)) as Row | undefined;
    return r && { ...(r as unknown as User), roles: JSON.parse(r.roles as string) };
  }

  listUsers(): User[] {
    return (this.db.prepare("SELECT id, name, roles, created_at FROM users ORDER BY created_at").all() as Row[]).map((r) => ({
      ...(r as unknown as User),
      roles: JSON.parse(r.roles as string),
    }));
  }

  // Products

  getProduct(id: string): ProductRecord | undefined {
    const r = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as Row | undefined;
    return r && toProductRecord(r);
  }

  publishedProducts(): FinancialProduct[] {
    return (this.db.prepare("SELECT * FROM products WHERE status = 'published' ORDER BY rowid").all() as Row[]).map(
      (r) => toProductRecord(r).product,
    );
  }

  productsByOwner(ownerId: string): ProductRecord[] {
    return (this.db.prepare("SELECT * FROM products WHERE owner_id = ? ORDER BY created_at").all(ownerId) as Row[]).map(toProductRecord);
  }

  insertDraft(ownerId: string, p: FinancialProduct): ProductRecord {
    const ts = now();
    this.db
      .prepare("INSERT INTO products (id, owner_id, status, data, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?)")
      .run(p.id, ownerId, JSON.stringify(p), ts, ts);
    return this.getProduct(p.id)!;
  }

  saveProduct(p: FinancialProduct, status: ProductStatus): ProductRecord {
    this.db.prepare("UPDATE products SET data = ?, status = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(p), status, now(), p.id);
    return this.getProduct(p.id)!;
  }

  saveTestReport(id: string, report: TestReport): void {
    this.db.prepare("UPDATE products SET last_test = ? WHERE id = ?").run(JSON.stringify(report), id);
  }

  setProductStatus(id: string, status: ProductStatus): ProductRecord {
    const ts = now();
    this.db
      .prepare("UPDATE products SET status = ?, updated_at = ?, published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END WHERE id = ?")
      .run(status, ts, status, ts, id);
    return this.getProduct(id)!;
  }

  // Enrollments

  createEnrollment(userId: string, productId: string, amount: number | null): Enrollment {
    const e: Enrollment = { id: randomUUID(), user_id: userId, product_id: productId, amount, status: "active", created_at: now() };
    this.db
      .prepare("INSERT INTO enrollments (id, user_id, product_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.id, userId, productId, amount, e.status, e.created_at);
    return e;
  }

  enrollmentsByUser(userId: string): Enrollment[] {
    return this.db.prepare("SELECT * FROM enrollments WHERE user_id = ? ORDER BY created_at").all(userId) as unknown as Enrollment[];
  }

  getEnrollment(id: string): Enrollment | undefined {
    return this.db.prepare("SELECT * FROM enrollments WHERE id = ?").get(id) as unknown as Enrollment | undefined;
  }

  cancelEnrollment(id: string): Enrollment {
    this.db.prepare("UPDATE enrollments SET status = 'cancelled' WHERE id = ?").run(id);
    return this.getEnrollment(id)!;
  }

  // Apps

  createApp(ownerId: string, fields: Pick<App, "name" | "description" | "audience" | "product_ids">): App {
    const ts = now();
    const app: App = { id: randomUUID(), owner_id: ownerId, ...fields, status: "draft", created_at: ts, updated_at: ts };
    this.db
      .prepare("INSERT INTO apps (id, owner_id, name, description, audience, product_ids, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(app.id, ownerId, app.name, app.description, app.audience, JSON.stringify(app.product_ids), app.status, ts, ts);
    return app;
  }

  getApp(id: string): App | undefined {
    const r = this.db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as Row | undefined;
    return r && toApp(r);
  }

  saveApp(app: App): App {
    this.db
      .prepare("UPDATE apps SET name = ?, description = ?, audience = ?, product_ids = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(app.name, app.description, app.audience, JSON.stringify(app.product_ids), app.status, now(), app.id);
    return this.getApp(app.id)!;
  }

  appsByOwner(ownerId: string): App[] {
    return (this.db.prepare("SELECT * FROM apps WHERE owner_id = ? ORDER BY created_at").all(ownerId) as Row[]).map(toApp);
  }

  publishedApps(): App[] {
    return (this.db.prepare("SELECT * FROM apps WHERE status = 'published' ORDER BY created_at").all() as Row[]).map(toApp);
  }

  close(): void {
    this.db.close();
  }
}
