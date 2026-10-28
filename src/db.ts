import pg from "pg";

// Minimal query interface satisfied by a pg Pool (production, e.g. Supabase Postgres)
// and by PGlite (in-process Postgres used in tests).
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

export function connectPostgres(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: Number(process.env.PGPOOL_MAX ?? 10) });
  return {
    query: (sql, params) => pool.query(sql, params) as never,
    exec: (sql) => pool.query(sql),
    close: () => pool.end(),
  };
}
