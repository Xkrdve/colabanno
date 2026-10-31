import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { signToken, requireAuth, type AuthedRequest } from '../mw/auth.js';
import { logEvent } from '../services/audit.js';

const router = Router();

// Connexion par e-mail OU username + mot de passe. Pas d'auto-inscription.
router.post('/login', async (req, res, next) => {
  try {
    const { identifiant, password } = req.body ?? {};
    if (!identifiant || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    const r = await query(
      'SELECT id, email, username, password_hash, role FROM utilisateur WHERE email=$1 OR username=$1',
      [String(identifiant).toLowerCase().trim()]);
    if (!r.rowCount) return res.status(401).json({ error: 'Identifiants invalides' });
    const u = r.rows[0];
    if (!bcrypt.compareSync(String(password), u.password_hash))
      return res.status(401).json({ error: 'Identifiants invalides' });
    const token = signToken(u);
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600_000 });
    await logEvent({ query }, { user_id: Number(u.id), action: 'login', entite: 'utilisateur', entite_id: Number(u.id), details: {} });
    res.json({ user: { id: Number(u.id), email: u.email, username: u.username, role: u.role } });
  } catch (e) { next(e); }
});

router.post('/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req: AuthedRequest, res) => res.json({ user: req.user }));

// Creation de compte UNIQUEMENT par l'admin (parametrage global).
router.post('/users', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Reserve a l\u2019admin' });
    const { email, username, password, role = 'annotateur' } = req.body ?? {};
    if (!email || !username || !password) return res.status(400).json({ error: 'email, username, password requis' });
    const hash = bcrypt.hashSync(String(password), 10);
    const r = await query(
      `INSERT INTO utilisateur (email, username, password_hash, role) VALUES ($1,$2,$3,$4)
       RETURNING id, email, username, role`,
      [String(email).toLowerCase().trim(), String(username).trim(), hash, role === 'admin' ? 'admin' : 'annotateur']);
    await logEvent({ query }, { user_id: req.user.id, action: 'user_creer', entite: 'utilisateur', entite_id: Number(r.rows[0].id), details: { username, role } });
    res.status(201).json({ user: r.rows[0] });
  } catch (e) { next(e); }
});

router.get('/users', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Reserve a l\u2019admin' });
    const r = await query('SELECT id, email, username, role, created_at FROM utilisateur ORDER BY id');
    res.json({ users: r.rows });
  } catch (e) { next(e); }
});

export default router;
