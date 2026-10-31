// Helper de tests : PostgreSQL embarque + migrations + serveur HTTP sur port
// ephemere (loopback uniquement).
import { startEmbeddedPg } from '../src/server/db/embedded.js';

process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123456789';
process.env.UPLOAD_DIR = './uploads-test';
process.env.EXPORT_DIR = './exports-test';

export async function bootTestServer() {
  const db = await startEmbeddedPg();
  process.env.DATABASE_URL = db.url;
  const { pool, migrate } = await import('../src/server/db/pool.js');
  await migrate();
  const { createServer } = await import('../src/server/index.js');
  const { server } = await createServer();
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const addr = server.address() as any;
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    base, pool, db,
    stop: async () => { await new Promise((r) => server.close(r)); await pool.end(); await db.stop(); },
  };
}

export async function api(base: string, path: string, opts: { method?: string; body?: any; token?: string; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let body: any = opts.body;
  if (opts.form) { body = opts.form; }
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const res = await fetch(base + path, { method: opts.method ?? 'GET', headers, body });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, token: res.headers.get('set-cookie')?.match(/token=([^;]+)/)?.[1] };
}

export async function login(base: string, identifiant: string, password: string) {
  const r = await api(base, '/api/auth/login', { method: 'POST', body: { identifiant, password } });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.data)}`);
  return { token: r.token!, user: r.data.user };
}
