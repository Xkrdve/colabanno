import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, requireAdmin, requireMember, type AuthedRequest } from '../mw/auth.js';
import { logEvent, auditList } from '../services/audit.js';
import { POSTES, type Poste } from '../../shared/types.js';
import { httpErr } from '../services/images.js';

const router = Router();

router.use(requireAuth);

// Page des projets : l'annotateur ne voit que ses projets autorises.
router.get('/', async (req: AuthedRequest, res, next) => {
  try {
    let r;
    if (req.user!.role === 'admin') {
      r = await query(`SELECT p.*, (SELECT count(*) FROM image i WHERE i.projet_id=p.id)::int AS nb_images,
        (SELECT count(*) FROM membre m WHERE m.projet_id=p.id)::int AS nb_membres
        FROM projet p ORDER BY p.id`);
    } else {
      r = await query(`SELECT p.*, (SELECT count(*) FROM image i WHERE i.projet_id=p.id)::int AS nb_images,
        m.permissions
        FROM projet p JOIN membre m ON m.projet_id=p.id AND m.user_id=$1 ORDER BY p.id`, [req.user!.id]);
    }
    res.json({ projets: r.rows });
  } catch (e) { next(e); }
});

router.post('/', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const { nom, description = '', pct_train = 80, pct_val = 10, pct_test = 10 } = req.body ?? {};
    if (!nom) return res.status(400).json({ error: 'nom requis' });
    if (pct_train + pct_val + pct_test !== 100) return res.status(400).json({ error: 'Les pourcentages train/val/test doivent totaliser 100' });
    const r = await tx(async (c) => {
      const p = await c.query(
        `INSERT INTO projet (nom, description, pct_train, pct_val, pct_test, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [nom, description, pct_train, pct_val, pct_test, req.user!.id]);
      await logEvent(c, { projet_id: Number(p.rows[0].id), user_id: req.user!.id, action: 'projet_creer', entite: 'projet', entite_id: Number(p.rows[0].id), details: { nom } });
      return p.rows[0];
    });
    res.status(201).json({ projet: r });
  } catch (e) { next(e); }
});

router.get('/:projetId', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const r = await query('SELECT * FROM projet WHERE id=$1', [req.params.projetId]);
    if (!r.rowCount) return res.status(404).json({ error: 'Projet introuvable' });
    res.json({ projet: r.rows[0] });
  } catch (e) { next(e); }
});

// ---------- Membres : autoriser des annotateurs, permissions par poste ----------
router.get('/:projetId/membres', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const r = await query(
      `SELECT m.user_id, u.username, u.email, u.role, m.permissions
       FROM membre m JOIN utilisateur u ON u.id=m.user_id WHERE m.projet_id=$1 ORDER BY u.username`,
      [req.params.projetId]);
    res.json({ membres: r.rows });
  } catch (e) { next(e); }
});

router.post('/:projetId/membres', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const { user_id, permissions } = req.body ?? {};
    const perms = Object.fromEntries(POSTES.map((p) => [p, permissions?.[p] !== false]));
    const r = await tx(async (c) => {
      const m = await c.query(
        `INSERT INTO membre (projet_id, user_id, permissions) VALUES ($1,$2,$3)
         ON CONFLICT (projet_id, user_id) DO UPDATE SET permissions=$3 RETURNING *`,
        [req.params.projetId, user_id, JSON.stringify(perms)]);
      await logEvent(c, { projet_id: Number(req.params.projetId), user_id: req.user!.id, action: 'membre_ajouter', entite: 'membre', entite_id: Number(user_id), details: { permissions: perms } });
      return m.rows[0];
    });
    res.json({ membre: r });
  } catch (e) { next(e); }
});

router.delete('/:projetId/membres/:userId', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    await tx(async (c) => {
      await c.query('DELETE FROM membre WHERE projet_id=$1 AND user_id=$2', [req.params.projetId, req.params.userId]);
      await logEvent(c, { projet_id: Number(req.params.projetId), user_id: req.user!.id, action: 'membre_retrait', entite: 'membre', entite_id: Number(req.params.userId), details: {} });
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Classes (z-index par glisser-deposer) ----------
router.get('/:projetId/classes', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const r = await query('SELECT * FROM classe WHERE projet_id=$1 ORDER BY z_index', [req.params.projetId]);
    res.json({ classes: r.rows });
  } catch (e) { next(e); }
});

router.post('/:projetId/classes', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const { nom, couleur = '#3b82f6' } = req.body ?? {};
    if (!nom) return res.status(400).json({ error: 'nom requis' });
    const r = await tx(async (c) => {
      const max = await c.query('SELECT coalesce(max(z_index),-1)+1 AS z FROM classe WHERE projet_id=$1', [req.params.projetId]);
      const cl = await c.query(
        'INSERT INTO classe (projet_id, nom, couleur, z_index) VALUES ($1,$2,$3,$4) RETURNING *',
        [req.params.projetId, nom, couleur, max.rows[0].z]);
      await logEvent(c, { projet_id: Number(req.params.projetId), user_id: req.user!.id, action: 'classe_creer', entite: 'classe', entite_id: Number(cl.rows[0].id), details: { nom, z_index: cl.rows[0].z_index } });
      return cl.rows[0];
    });
    res.status(201).json({ classe: r });
  } catch (e) { next(e); }
});

// Reordonne les classes (glisser-deposer du z-index).
router.put('/:projetId/classes/ordre', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const { ordre } = req.body ?? {}; // [classId, ...]
    if (!Array.isArray(ordre)) return res.status(400).json({ error: 'ordre (tableau d\u2019ids) requis' });
    await tx(async (c) => {
      for (let i = 0; i < ordre.length; i++) {
        await c.query('UPDATE classe SET z_index=$1 WHERE id=$2 AND projet_id=$3', [i, ordre[i], req.params.projetId]);
      }
      await logEvent(c, { projet_id: Number(req.params.projetId), user_id: req.user!.id, action: 'classes_reordonnees', entite: 'classe', details: { ordre } });
    });
    const r = await query('SELECT * FROM classe WHERE projet_id=$1 ORDER BY z_index', [req.params.projetId]);
    res.json({ classes: r.rows });
  } catch (e) { next(e); }
});

// Suppression de classe avec warning puis reclassification OU suppression des instances.
router.delete('/:projetId/classes/:classeId', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const { onDelete = 'reclassifier' } = req.body ?? {}; // 'reclassifier' (class_id=NULL) | 'supprimer'
    const nb = await query('SELECT count(*)::int AS n FROM instance WHERE class_id=$1 AND deleted_at IS NULL', [req.params.classeId]);
    if (nb.rows[0].n > 0 && !['reclassifier', 'supprimer'].includes(onDelete))
      return res.status(400).json({ error: 'onDelete requis: reclassifier | supprimer', warning: `${nb.rows[0].n} instance(s) concernee(s)` });
    await tx(async (c) => {
      if (onDelete === 'supprimer') {
        await c.query('UPDATE instance SET deleted_at=now() WHERE class_id=$1 AND deleted_at IS NULL', [req.params.classeId]);
      } else {
        await c.query('UPDATE instance SET class_id=NULL WHERE class_id=$1', [req.params.classeId]);
      }
      await c.query('DELETE FROM classe WHERE id=$1 AND projet_id=$2', [req.params.classeId, req.params.projetId]);
      await logEvent(c, { projet_id: Number(req.params.projetId), user_id: req.user!.id, action: 'classe_supprimer', entite: 'classe', entite_id: Number(req.params.classeId), details: { onDelete, instances_touchees: nb.rows[0].n } });
    });
    const warning = nb.rows[0].n > 0 ? `${nb.rows[0].n} instance(s) ${onDelete === 'supprimer' ? 'supprimee(s)' : 'reclassee(s) (class_id=NULL)'}` : null;
    res.json({ ok: true, warning });
  } catch (e) { next(e); }
});

// ---------- Audit (admin) ----------
router.get('/:projetId/audit', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const items = await auditList({
      projet_id: Number(req.params.projetId),
      entite: req.query.entite as string | undefined,
      entite_id: req.query.entite_id ? Number(req.query.entite_id) : undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : 500,
    });
    res.json({ evenements: items });
  } catch (e) { next(e); }
});

export default router;
