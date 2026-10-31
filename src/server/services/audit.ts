import type { PoolClient } from 'pg';
import { query } from '../db/pool.js';

export interface AuditInput {
  projet_id?: number | null;
  user_id?: number | null;
  action: string;
  entite: string;
  entite_id?: number | null;
  details?: Record<string, unknown>;
}

type Q = { query: (t: string, p?: any[]) => Promise<any> };

export async function logEvent(q: Q, e: AuditInput): Promise<void> {
  await q.query(
    `INSERT INTO evenement (projet_id, user_id, action, entite, entite_id, details)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.projet_id ?? null, e.user_id ?? null, e.action, e.entite, e.entite_id ?? null,
     JSON.stringify(e.details ?? {})]
  );
}

export async function auditList(opts: {
  projet_id: number; entite?: string; entite_id?: number;
  from?: string; to?: string; limit?: number;
}) {
  const where: string[] = ['e.projet_id = $1'];
  const params: any[] = [opts.projet_id];
  if (opts.entite) { params.push(opts.entite); where.push(`e.entite = $${params.length}`); }
  if (opts.entite_id != null) { params.push(opts.entite_id); where.push(`e.entite_id = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`e.created_at >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`e.created_at <= $${params.length}`); }
  params.push(opts.limit ?? 500);
  const r = await query(
    `SELECT e.id, e.action, e.entite, e.entite_id, e.user_id, u.username, e.details, e.created_at
     FROM evenement e LEFT JOIN utilisateur u ON u.id = e.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY e.created_at DESC, e.id DESC LIMIT $${params.length}`, params);
  return r.rows;
}
