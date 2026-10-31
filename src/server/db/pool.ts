import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { Pool } = pg;

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/instanceseg',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me-32-chars!!',
  port: Number(process.env.PORT || 4000),
  uploadDir: path.resolve(process.env.UPLOAD_DIR || './uploads'),
  exportDir: path.resolve(process.env.EXPORT_DIR || './exports'),
  trashRetentionDays: Number(process.env.TRASH_RETENTION_DAYS || 7),
  reserveSize: 50,
};

for (const d of [config.uploadDir, config.exportDir]) fs.mkdirSync(d, { recursive: true });

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
});

export async function query<T = any>(text: string, params?: any[]): Promise<pg.QueryResult<any>> {
  const r = await pool.query(text, params);
  return r as pg.QueryResult<any>;
}

export interface TxClient {
  query(text: string, params?: any[]): Promise<pg.QueryResult<any>>;
}

export async function tx<T>(fn: (client: TxClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const c: TxClient = { query: (t, p) => client.query(t, p as any) as Promise<pg.QueryResult<any>> };
  try {
    await client.query('BEGIN');
    const r = await fn(c);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export function sha256File(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(absPath);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

export async function migrate(migrationsDir = path.resolve('migrations')): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await query('SELECT 1 FROM schema_migrations WHERE version=$1', [f]);
    if (done.rowCount) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(version) VALUES ($1)', [f]);
    });
    console.log(`[migrate] applique ${f}`);
  }
}
