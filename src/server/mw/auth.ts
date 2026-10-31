import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config, query } from '../db/pool.js';

export interface AuthedRequest extends Request {
  user?: { id: number; email: string; username: string; role: 'admin' | 'annotateur' };
}

export function signToken(user: { id: number; role: string }) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '12h' });
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.token || (req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : undefined);
  if (!token) return res.status(401).json({ error: 'Non authentifie' });
  try {
    const payload = jwt.verify(token, config.jwtSecret) as any;
    const r = await query('SELECT id, email, username, role FROM utilisateur WHERE id=$1', [payload.sub]);
    if (!r.rowCount) return res.status(401).json({ error: 'Utilisateur inconnu' });
    req.user = r.rows[0] as any;
    next();
  } catch {
    return res.status(401).json({ error: 'Session invalide' });
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Reserve a l\u2019admin' });
  next();
}

export async function requireMember(req: AuthedRequest, res: Response, next: NextFunction) {
  const projetId = Number(req.params.projetId ?? req.body.projetId);
  if (!req.user) return res.status(401).json({ error: 'Non authentifie' });
  if (req.user.role === 'admin') return next();
  const r = await query('SELECT 1 FROM membre WHERE projet_id=$1 AND user_id=$2', [projetId, req.user.id]);
  if (!r.rowCount) return res.status(403).json({ error: 'Projet non autorise' });
  next();
}

export function errHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status = err.status || (err.code === '23505' ? 409 : 500);
  if (status === 500) console.error('[500]', err);
  res.status(status).json({ error: err.message || 'Erreur interne', code: err.code, locked_by: err.locked_by });
}
