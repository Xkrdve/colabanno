import { Router } from 'express';
import { pool, tx, query } from '../db/pool.js';
import { requireAuth, requireMember, type AuthedRequest } from '../mw/auth.js';
import { POSTES, type Poste } from '../../shared/types.js';
import { listQueue, openItem, counters, notifyCounters } from '../services/queue.js';
import {
  localisationSave, localisationAddOnly, classify, segment, contest,
  validateInstance, validateImage, getImage, getInstance,
} from '../services/workflow.js';
import { logEvent } from '../services/audit.js';
import { broadcastEvent } from '../ws.js';

const router = Router();
router.use(requireAuth);

function parsePoste(p: string): Poste {
  if (!POSTES.includes(p as Poste)) throw Object.assign(new Error('Poste inconnu'), { status: 400 });
  return p as Poste;
}

// File d'un poste (ordre aleatoire, reserve perso de 50, compteurs).
router.get('/:projetId/postes/:poste/file', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const poste = parsePoste(req.params.poste);
    const client = await pool.connect();
    try {
      const items = await listQueue(client, Number(req.params.projetId), req.user!.id, poste);
      const c = await counters(Number(req.params.projetId), poste);
      res.json({ items, compteurs: c });
    } finally { client.release(); }
  } catch (e) { next(e); }
});

// Compteurs temps reel (fallback du WS).
router.get('/:projetId/postes/:poste/compteurs', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const poste = parsePoste(req.params.poste);
    res.json(await counters(Number(req.params.projetId), poste));
  } catch (e) { next(e); }
});

// Ouvre (verrouille) un item du poste.
router.post('/:projetId/postes/:poste/ouvrir', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const poste = parsePoste(req.params.poste);
    const { kind, item_id } = req.body ?? {};
    const client = await pool.connect();
    try {
      await tx(async (c) => {
        await openItem(c, Number(req.params.projetId), req.user!.id, poste, kind, Number(item_id));
        await logEvent(c, { projet_id: Number(req.params.projetId), user_id: req.user!.id, action: 'item_ouvrir', entite: kind, entite_id: Number(item_id), details: { poste } });
      });
      await notifyCounters(Number(req.params.projetId), poste);
      res.json({ ok: true });
    } finally { client.release(); }
  } catch (e) { next(e); }
});

// Detail d'un item ouvert (image entiere ou instance + crop).
router.get('/:projetId/postes/:poste/item/:kind/:itemId', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const kind = req.params.kind as 'image' | 'instance';
    const itemId = Number(req.params.itemId);
    if (kind === 'image') {
      const img = await getImage({ query: query as any }, itemId);
      const inst = await query(
        `SELECT x.*, instance_stage(x) AS stage, c.nom AS class_nom, c.couleur FROM instance x
         LEFT JOIN classe c ON c.id=x.class_id WHERE x.image_id=$1 AND x.deleted_at IS NULL ORDER BY x.id`, [itemId]);
      return res.json({ image: img, instances: inst.rows });
    }
    const inst = await getInstance({ query: query as any }, itemId);
    const img = await getImage({ query: query as any }, Number(inst.image_id));
    res.json({ instance: inst, image: img });
  } catch (e) { next(e); }
});

// ---------- Actions des 5 postes ----------
router.post('/:projetId/postes/localisation/terminer', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const { image_id, boxes = [], negative = false } = req.body ?? {};
    const client = await pool.connect();
    try {
      await localisationSave(client, { userId: req.user!.id, projetId: Number(req.params.projetId), imageId: Number(image_id), boxes, negative });
      res.json({ ok: true });
    } finally { client.release(); }
  } catch (e) { next(e); }
});

router.post('/:projetId/postes/localisation/ajouter', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const { image_id, boxes = [] } = req.body ?? {};
    const client = await pool.connect();
    try {
      await localisationAddOnly(client, { userId: req.user!.id, projetId: Number(req.params.projetId), imageId: Number(image_id), boxes });
      res.json({ ok: true });
    } finally { client.release(); }
  } catch (e) { next(e); }
});

router.post('/:projetId/postes/classification', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const { instance_id, class_id } = req.body ?? {};
    const client = await pool.connect();
    try {
      await classify(client, { userId: req.user!.id, projetId: Number(req.params.projetId), instanceId: Number(instance_id), classId: Number(class_id) });
      const nextInst = await listQueue(client, Number(req.params.projetId), req.user!.id, 'classification');
      res.json({ ok: true, file: nextInst });
    } finally { client.release(); }
  } catch (e) { next(e); }
});

router.post('/:projetId/postes/segmentation', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const { instance_id, polygon } = req.body ?? {};
    const client = await pool.connect();
    try {
      await segment(client, { userId: req.user!.id, projetId: Number(req.params.projetId), instanceId: Number(instance_id), polygon });
      res.json({ ok: true });
    } finally { client.release(); }
  } catch (e) { next(e); }
});

router.post('/:projetId/postes/contester', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const { instance_id, poste } = req.body ?? {};
    const client = await pool.connect();
    try {
      await contest(client, { userId: req.user!.id, projetId: Number(req.params.projetId), instanceId: Number(instance_id), poste });
      res.json({ ok: true });
    } finally { client.release(); }
  } catch (e) { next(e); }
});

router.post('/:projetId/postes/validation_instance', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const { instance_id, decision, commentaire } = req.body ?? {};
    const client = await pool.connect();
    try {
      await validateInstance(client, {
        userId: req.user!.id, projetId: Number(req.params.projetId),
        instanceId: Number(instance_id), decision, commentaire,
      });
      const file = await listQueue(client, Number(req.params.projetId), req.user!.id, 'validation_instance');
      res.json({ ok: true, file });
    } finally { client.release(); }
  } catch (e) { next(e); }
});

router.post('/:projetId/postes/validation_image', requireMember, async (req: AuthedRequest, res, next) => {
  try {
    const { image_id, decision } = req.body ?? {};
    const client = await pool.connect();
    try {
      await validateImage(client, { userId: req.user!.id, projetId: Number(req.params.projetId), imageId: Number(image_id), decision });
      res.json({ ok: true });
    } finally { client.release(); }
  } catch (e) { next(e); }
});

export default router;
