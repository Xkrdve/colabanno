import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import { query, tx } from '../db/pool.js';
import { requireAuth, requireAdmin, requireMember, type AuthedRequest } from '../mw/auth.js';
import { logEvent, auditList } from '../services/audit.js';
import { importOne, backgroundDuplicateCheck, ALLOWED_MIME } from '../services/images.js';
import { trashList, trashRestore, purgeTrash } from '../services/workflow.js';
import { startAutoExport, enqueueExport, type ExportFilters, type ExportFormat } from '../services/exports.js';
import { stats } from '../services/stats.js';

const router = Router();
router.use(requireAuth);

const upload = multer({
  dest: path.join(os.tmpdir(), 'instanceseg-uploads'),
  limits: { fileSize: 50 * 1024 * 1024, files: 100 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(new Error('PNG/JPG uniquement'));
    cb(null, true);
  },
});

// ---------- Import multiple d'images (anti-doublons par hash) ----------
router.post('/:projetId/images/import', requireAdmin, upload.array('fichiers', 100), async (req: AuthedRequest, res, next) => {
  try {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) return res.status(400).json({ error: 'Aucun fichier' });
    const results = [];
    for (const f of files) {
      try { results.push(await importOne(Number(req.params.projetId), req.user!.id, f.path, f.originalname)); }
      catch (e: any) { results.push({ status: 'erreur', nom: f.originalname, error: e.message }); }
    }
    // comparaison en arriere-plan, non bloquante
    backgroundDuplicateCheck(Number(req.params.projetId)).catch(() => {});
    res.json({ importes: results.filter((r) => r.status === 'importee').length,
               doublons: results.filter((r) => r.status === 'doublon').length, details: results });
  } catch (e) { next(e); }
});

// ---------- Vue globale du projet : images par stade + filtres ----------
router.get('/:projetId/images', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const p = Number(req.params.projetId);
    const cond: string[] = ['i.projet_id=$1'];
    const params: any[] = [p];
    if (req.query.split) { params.push(req.query.split); cond.push(`i.split=$${params.length}`); }
    if (req.query.validee === 'true') cond.push('i.validee=TRUE');
    if (req.query.validee === 'false') cond.push('i.validee=FALSE');
    if (req.query.negative === 'true') cond.push('i.negative=TRUE');
    if (req.query.marque === 'true' && req.user) {
      cond.push(`EXISTS (SELECT 1 FROM marque mk WHERE mk.image_id=i.id AND mk.user_id=$${params.length + 1})`);
      params.push(req.user.id);
    }
    if (req.query.classe) {
      params.push(Number(req.query.classe));
      cond.push(`EXISTS (SELECT 1 FROM instance x WHERE x.image_id=i.id AND x.deleted_at IS NULL AND x.class_id=$${params.length})`);
    }
    const r = await query(
      `SELECT i.*,
        (SELECT count(*)::int FROM instance x WHERE x.image_id=i.id AND x.deleted_at IS NULL) AS nb_instances,
        (SELECT count(*)::int FROM instance x WHERE x.image_id=i.id AND x.deleted_at IS NULL AND x.validee=TRUE) AS nb_validees,
        (SELECT jsonb_agg(DISTINCT x.class_id) FROM instance x WHERE x.image_id=i.id AND x.deleted_at IS NULL AND x.class_id IS NOT NULL) AS classes_presentes,
        EXISTS (SELECT 1 FROM marque mk WHERE mk.image_id=i.id AND mk.user_id=$2) AS marquee
       FROM image i WHERE ${cond.join(' AND ')} ORDER BY i.id DESC LIMIT 500`, [p, req.user!.id, ...params.slice(1)] as any);
    res.json({ images: r.rows });
  } catch (e) { next(e); }
});

router.get('/:projetId/images/:imageId', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const img = await query('SELECT * FROM image WHERE id=$1 AND projet_id=$2', [req.params.imageId, req.params.projetId]);
    if (!img.rowCount) return res.status(404).json({ error: 'Image introuvable' });
    const inst = await query(
      `SELECT x.*, instance_stage(x) AS stage, c.nom AS class_nom, c.couleur
       FROM instance x LEFT JOIN classe c ON c.id=x.class_id
       WHERE x.image_id=$1 AND x.deleted_at IS NULL ORDER BY x.id`, [req.params.imageId]);
    res.json({ image: img.rows[0], instances: inst.rows });
  } catch (e) { next(e); }
});

// ---------- Marques (favoris prives par compte) ----------
router.post('/:projetId/images/:imageId/marque', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    await tx(async (c) => {
      await c.query('INSERT INTO marque (image_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [req.params.imageId, req.user!.id]);
      await logEvent(c, { projet_id: Number(req.params.projetId), user_id: req.user!.id, action: 'marque_ajouter', entite: 'image', entite_id: Number(req.params.imageId), details: {} });
    });
    res.json({ ok: true, marquee: true });
  } catch (e) { next(e); }
});
router.delete('/:projetId/images/:imageId/marque', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    await query('DELETE FROM marque WHERE image_id=$1 AND user_id=$2', [req.params.imageId, req.user!.id]);
    res.json({ ok: true, marquee: false });
  } catch (e) { next(e); }
});

// ---------- Historique d'audit par image (admin), filtre chronologique ----------
router.get('/:projetId/images/:imageId/audit', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const items = await auditList({
      projet_id: Number(req.params.projetId),
      entite_id: Number(req.params.imageId),
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      limit: 1000,
    });
    const inst = await auditList({ projet_id: Number(req.params.projetId), entite: 'instance', limit: 2000 });
    const ids = new Set((await query('SELECT id FROM instance WHERE image_id=$1', [req.params.imageId])).rows.map((r) => Number(r.id)));
    const lies = inst.filter((e) => ids.has(Number(e.entite_id)));
    res.json({ evenements: [...items, ...lies].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) });
  } catch (e) { next(e); }
});

// ---------- Corbeille (admin) + purge auto 7 jours ----------
router.get('/:projetId/trash', requireAdmin, async (req: AuthedRequest, res, next) => {
  try { res.json({ corbeille: await trashList(Number(req.params.projetId)) }); }
  catch (e) { next(e); }
});
router.post('/:projetId/trash/:instanceId/restaurer', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    await trashRestoreAt(Number(req.params.projetId), req.user!.id, Number(req.params.instanceId));
    res.json({ ok: true });
  } catch (e) { next(e); }
});
async function trashRestoreAt(projetId: number, userId: number, instanceId: number) {
  const { pool } = await import('../db/pool.js');
  const client = await pool.connect();
  try { await trashRestore(client, userId, projetId, instanceId); }
  finally { client.release(); }
}
router.post('/:projetId/trash/purge', requireAdmin, async (_req, res, next) => {
  try { res.json({ purgees: await purgeTrash() }); } catch (e) { next(e); }
});

// ---------- Statistiques (admin, calculees a la volee) ----------
router.get('/:projetId/stats', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    res.json(await stats(Number(req.params.projetId), {
      classId: req.query.classe ? Number(req.query.classe) : undefined,
      userId: req.query.annotateur ? Number(req.query.annotateur) : undefined,
      jour: req.query.jour as string | undefined,
      stage: req.query.stage as string | undefined,
    }));
  } catch (e) { next(e); }
});

// ---------- Exports (admin) ----------
router.post('/:projetId/exports', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const { format, filters } = req.body ?? {};
    if (!['coco', 'yolo-seg', 'semantique'].includes(format))
      return res.status(400).json({ error: 'format: coco | yolo-seg | semantique' });
    const f: ExportFilters = {
      classIds: filters?.classIds, imageIds: filters?.imageIds,
      from: filters?.from, to: filters?.to, splits: filters?.splits,
    };
    const jobId = await enqueueExport(Number(req.params.projetId), req.user!.id, format as ExportFormat, f);
    res.status(202).json({ jobId });
  } catch (e) { next(e); }
});
router.get('/:projetId/exports', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const r = await query('SELECT * FROM job WHERE projet_id=$1 AND type=$2 ORDER BY id DESC LIMIT 50', [req.params.projetId, 'export']);
    res.json({ jobs: r.rows });
  } catch (e) { next(e); }
});
// Active/desactive l'export automatique periodique du projet.
router.post('/:projetId/exports/auto', requireAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const { enabled, intervalMin = 60 } = req.body ?? {};
    if (enabled) {
      const stop = startAutoExport(Number(req.params.projetId), intervalMin);
      autoStops.set(Number(req.params.projetId), stop);
      await logEvent({ query }, { projet_id: Number(req.params.projetId), user_id: req.user!.id, action: 'export_auto_actif', entite: 'projet', entite_id: Number(req.params.projetId), details: { intervalMin } });
    } else {
      autoStops.get(Number(req.params.projetId))?.();
      autoStops.delete(Number(req.params.projetId));
      await logEvent({ query }, { projet_id: Number(req.params.projetId), user_id: req.user!.id, action: 'export_auto_desactif', entite: 'projet', entite_id: Number(req.params.projetId), details: {} });
    }
    res.json({ ok: true, enabled: !!enabled });
  } catch (e) { next(e); }
});
const autoStops = new Map<number, () => void>();

export default router;
