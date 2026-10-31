// Workflow des 5 postes : transitions de stades, refus cibles, contestation,
// corbeille (suppression douce), restauration, purge automatique a 7 jours.
import type { PoolClient } from 'pg';
import { query, tx, config } from '../db/pool.js';
import type { BBox, Point, Poste } from '../../shared/types.js';
import { stageOf } from '../../shared/types.js';
import { logEvent } from './audit.js';
import { openItem, releaseItem, refillReserve, notifyCounters } from './queue.js';
import { ensureCrop, httpErr } from './images.js';

type Q = { query: (t: string, p?: any[]) => Promise<any> };

export async function getInstance(q: Q, id: number) {
  const r = await q.query(
    `SELECT x.*, instance_stage(x) AS stage, i.projet_id, c.nom AS class_nom, c.couleur
     FROM instance x JOIN image i ON i.id=x.image_id LEFT JOIN classe c ON c.id=x.class_id
     WHERE x.id=$1`, [id]);
  if (!r.rowCount) throw httpErr(404, 'Instance introuvable');
  return r.rows[0];
}

export async function getImage(q: Q, id: number) {
  const r = await q.query('SELECT * FROM image WHERE id=$1', [id]);
  if (!r.rowCount) throw httpErr(404, 'Image introuvable');
  return r.rows[0];
}

async function mustBeMember(q: Q, projetId: number, userId: number, poste: Poste) {
  const m = await q.query(
    `SELECT permissions FROM membre WHERE projet_id=$1 AND user_id=$2`, [projetId, userId]);
  if (!m.rowCount) throw httpErr(403, 'Non membre du projet');
  const perms = m.rows[0].permissions;
  if (perms && perms[poste] === false) throw httpErr(403, `Poste ${poste} non autorise pour ce membre`);
}

async function assertOwnerOfLock(q: Q, kind: 'image' | 'instance', itemId: number, userId: number) {
  const r = await q.query('SELECT user_id::text AS user_id FROM reservation WHERE item_kind=$1 AND item_id=$2', [kind, itemId]);
  if (!r.rowCount || String(r.rows[0].user_id) !== String(userId)) {
    throw httpErr(409, 'Item non verrouille par vous (repris par un autre utilisateur ?)');
  }
}

// ---------- Poste 1 : localisation ----------
export async function localisationSave(client: PoolClient, opts: {
  userId: number; projetId: number; imageId: number;
  boxes: { bbox: BBox }[]; negative: boolean;
}) {
  await mustBeMember(client, opts.projetId, opts.userId, 'localisation');
  await assertOwnerOfLock(client, 'image', opts.imageId, opts.userId);
  const img = await getImage(client, opts.imageId);
  if (String(img.projet_id) !== String(opts.projetId)) throw httpErr(404, 'Image hors projet');

  return tx(async (c) => {
    if (opts.negative) {
      await c.query('UPDATE image SET negative=TRUE, localisation_done=TRUE, relocalisation_ajout=FALSE WHERE id=$1', [opts.imageId] as any);
      await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'image_negative', entite: 'image', entite_id: opts.imageId, details: {} });
    } else {
      for (const b of opts.boxes) {
        const r: any = await c.query(
          `INSERT INTO instance (image_id, bbox, created_by) VALUES ($1,$2,$3) RETURNING id`,
          [opts.imageId, JSON.stringify(b.bbox), opts.userId] as any);
        await ensureCrop(opts.imageId, b.bbox).then((crop) =>
          c.query('UPDATE instance SET crop_chemin=$1 WHERE id=$2', [crop, r.rows[0].id]));
        await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'instance_creer', entite: 'instance', entite_id: Number(r.rows[0].id), details: { bbox: b.bbox } });
      }
      await c.query('UPDATE image SET negative=FALSE, localisation_done=TRUE WHERE id=$1', [opts.imageId] as any);
      await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'image_localisee', entite: 'image', entite_id: opts.imageId, details: { nb_instances: opts.boxes.length } });
    }
    await releaseItem(c, opts.projetId, opts.userId, 'localisation', 'image', opts.imageId);
  });
}

// Poste 1 en mode AJOUT UNIQUEMENT (flag "localisation manquante") :
// instances validees conservees, ni modification ni suppression.
export async function localisationAddOnly(client: PoolClient, opts: {
  userId: number; projetId: number; imageId: number; boxes: { bbox: BBox }[];
}) {
  await mustBeMember(client, opts.projetId, opts.userId, 'localisation');
  await assertOwnerOfLock(client, 'image', opts.imageId, opts.userId);
  const img = await getImage(client, opts.imageId);
  if (!img.relocalisation_ajout) throw httpErr(409, 'Image non en mode ajout uniquement');
  return tx(async (c) => {
    for (const b of opts.boxes) {
      const r: any = await c.query(
        `INSERT INTO instance (image_id, bbox, created_by) VALUES ($1,$2,$3) RETURNING id`,
        [opts.imageId, JSON.stringify(b.bbox), opts.userId] as any);
      await ensureCrop(opts.imageId, b.bbox).then((crop) =>
        c.query('UPDATE instance SET crop_chemin=$1 WHERE id=$2', [crop, r.rows[0].id]));
      await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'instance_creer', entite: 'instance', entite_id: Number(r.rows[0].id), details: { bbox: b.bbox, mode: 'ajout_uniquement' } });
    }
    await c.query('UPDATE image SET relocalisation_ajout=FALSE, localisation_done=TRUE WHERE id=$1', [opts.imageId] as any);
    await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'image_relocalisee', entite: 'image', entite_id: opts.imageId, details: { ajouts: opts.boxes.length } });
    await releaseItem(c, opts.projetId, opts.userId, 'localisation', 'image', opts.imageId);
  });
}

// ---------- Poste 2 : classification (crop uniquement) ----------
export async function classify(client: PoolClient, opts: {
  userId: number; projetId: number; instanceId: number; classId: number;
}) {
  await mustBeMember(client, opts.projetId, opts.userId, 'classification');
  await assertOwnerOfLock(client, 'instance', opts.instanceId, opts.userId);
  return tx(async (c) => {
    const inst = await getInstance(c, opts.instanceId);
    if (String(inst.projet_id) !== String(opts.projetId)) throw httpErr(404, 'Instance hors projet');
    if (!inst.bbox || inst.class_id) throw httpErr(409, 'Instance non au stade classification');
    const cls = await c.query('SELECT id FROM classe WHERE id=$1 AND projet_id=$2', [opts.classId, opts.projetId] as any);
    if (!cls.rowCount) throw httpErr(404, 'Classe inconnue');
    await c.query('UPDATE instance SET class_id=$1, updated_at=now() WHERE id=$2', [opts.classId, opts.instanceId] as any);
    await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'instance_classifier', entite: 'instance', entite_id: opts.instanceId, details: { class_id: opts.classId } });
    await releaseItem(c, opts.projetId, opts.userId, 'classification', 'instance', opts.instanceId);
    await notifyCounters(opts.projetId);
  });
}

// ---------- Poste 3 : segmentation (crop uniquement) ----------
export async function segment(client: PoolClient, opts: {
  userId: number; projetId: number; instanceId: number; polygon: Point[];
}) {
  await mustBeMember(client, opts.projetId, opts.userId, 'segmentation');
  await assertOwnerOfLock(client, 'instance', opts.instanceId, opts.userId);
  if (!opts.polygon || opts.polygon.length < 3) throw httpErr(400, 'Polygone invalide (< 3 points)');
  return tx(async (c) => {
    const inst = await getInstance(c, opts.instanceId);
    if (String(inst.projet_id) !== String(opts.projetId)) throw httpErr(404, 'Instance hors projet');
    if (!inst.bbox || !inst.class_id || inst.polygon) throw httpErr(409, 'Instance non au stade segmentation');
    await c.query('UPDATE instance SET polygon=$1, updated_at=now() WHERE id=$2',
      [JSON.stringify(opts.polygon), opts.instanceId] as any);
    await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'instance_segmenter', entite: 'instance', entite_id: opts.instanceId, details: { nb_points: opts.polygon.length } });
    await releaseItem(c, opts.projetId, opts.userId, 'segmentation', 'instance', opts.instanceId);
    await notifyCounters(opts.projetId);
  });
}

// ---------- Contestation (postes 2 et 3) : instance -> corbeille ----------
export async function contest(client: PoolClient, opts: {
  userId: number; projetId: number; instanceId: number; poste: 'classification' | 'segmentation';
}) {
  await mustBeMember(client, opts.projetId, opts.userId, opts.poste);
  await assertOwnerOfLock(client, 'instance', opts.instanceId, opts.userId);
  return tx(async (c) => {
    const inst = await getInstance(c, opts.instanceId);
    if (String(inst.projet_id) !== String(opts.projetId)) throw httpErr(404, 'Instance hors projet');
    await c.query('UPDATE instance SET deleted_at=now(), updated_at=now() WHERE id=$1', [opts.instanceId] as any);
    await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'instance_contestee', entite: 'instance', entite_id: opts.instanceId, details: { poste: opts.poste } });
    await releaseItem(c, opts.projetId, opts.userId, opts.poste, 'instance', opts.instanceId);
    await notifyCounters(opts.projetId);
  });
}

// ---------- Poste 4 : validation d'instance ----------
// - valider
// - refuser vers classification : class_id effacee, polygone conserve
// - refuser vers segmentation : polygone efface, classe conservee
// commentaire optionnel transmis a l'annotateur qui reprend.
export async function validateInstance(client: PoolClient, opts: {
  userId: number; projetId: number; instanceId: number;
  decision: 'valider' | 'refuser_classification' | 'refuser_segmentation';
  commentaire?: string;
}) {
  await mustBeMember(client, opts.projetId, opts.userId, 'validation_instance');
  await assertOwnerOfLock(client, 'instance', opts.instanceId, opts.userId);
  return tx(async (c) => {
    const inst = await getInstance(c, opts.instanceId);
    if (String(inst.projet_id) !== String(opts.projetId)) throw httpErr(404, 'Instance hors projet');
    if (!inst.bbox || !inst.class_id || !inst.polygon || inst.validee)
      throw httpErr(409, 'Instance non au stade validation');
    if (opts.decision === 'valider') {
      await c.query('UPDATE instance SET validee=TRUE, updated_at=now() WHERE id=$1', [opts.instanceId] as any);
      await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'instance_validee', entite: 'instance', entite_id: opts.instanceId, details: { commentaire: opts.commentaire ?? null } });
    } else if (opts.decision === 'refuser_classification') {
      await c.query('UPDATE instance SET class_id=NULL, updated_at=now() WHERE id=$1', [opts.instanceId] as any);
      await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'instance_refusee_vers_classification', entite: 'instance', entite_id: opts.instanceId,
        details: { commentaire: opts.commentaire ?? null, transmis_a: inst.created_by } });
    } else {
      await c.query('UPDATE instance SET polygon=NULL, updated_at=now() WHERE id=$1', [opts.instanceId] as any);
      await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'instance_refusee_vers_segmentation', entite: 'instance', entite_id: opts.instanceId,
        details: { commentaire: opts.commentaire ?? null, transmis_a: inst.created_by } });
    }
    await releaseItem(c, opts.projetId, opts.userId, 'validation_instance', 'instance', opts.instanceId);
    await notifyCounters(opts.projetId);
  });
}

// ---------- Poste 5 : validation d'image ----------
// - valider l'image (toutes instances validees ou image negative)
// - flag "localisation manquante" : retour poste 1 en mode AJOUT UNIQUEMENT
export async function validateImage(client: PoolClient, opts: {
  userId: number; projetId: number; imageId: number;
  decision: 'valider' | 'localisation_manquante';
}) {
  await mustBeMember(client, opts.projetId, opts.userId, 'validation_image');
  await assertOwnerOfLock(client, 'image', opts.imageId, opts.userId);
  return tx(async (c) => {
    const img = await getImage(c, opts.imageId);
    if (String(img.projet_id) !== String(opts.projetId)) throw httpErr(404, 'Image hors projet');
    if (img.validee) throw httpErr(409, 'Image deja validee');
    if (opts.decision === 'valider') {
      const pending = await c.query(
        'SELECT count(*)::int AS n FROM instance WHERE image_id=$1 AND deleted_at IS NULL AND validee=FALSE', [opts.imageId] as any);
      if (!img.negative && pending.rows[0].n > 0)
        throw httpErr(409, 'Toutes les instances doivent etre validees (ou image negative)');
      await c.query('UPDATE image SET validee=TRUE WHERE id=$1', [opts.imageId] as any);
      await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'image_validee', entite: 'image', entite_id: opts.imageId, details: {} });
    } else {
      await c.query('UPDATE image SET relocalisation_ajout=TRUE WHERE id=$1', [opts.imageId] as any);
      await logEvent(c, { projet_id: opts.projetId, user_id: opts.userId, action: 'image_localisation_manquante', entite: 'image', entite_id: opts.imageId, details: {} });
    }
    await releaseItem(c, opts.projetId, opts.userId, 'validation_image', 'image', opts.imageId);
    await notifyCounters(opts.projetId);
  });
}

// ---------- Corbeille (admin) ----------
export async function trashList(projetId: number) {
  const r = await query(
    `SELECT x.id, x.image_id, x.deleted_at, instance_stage(x) AS stage_avant, i.chemin,
            x.bbox, x.class_id, c.nom AS class_nom, x.polygon
     FROM instance x JOIN image i ON i.id=x.image_id LEFT JOIN classe c ON c.id=x.class_id
     WHERE i.projet_id=$1 AND x.deleted_at IS NOT NULL
     ORDER BY x.deleted_at DESC`, [projetId]);
  return r.rows;
}

export async function trashRestore(client: PoolClient, userId: number, projetId: number, instanceId: number) {
  return tx(async (c) => {
    const inst = await getInstance(c, instanceId);
    if (String(inst.projet_id) !== String(projetId)) throw httpErr(404, 'Instance hors projet');
    if (!inst.deleted_at) throw httpErr(409, 'Instance non en corbeille');
    await c.query('UPDATE instance SET deleted_at=NULL, updated_at=now() WHERE id=$1', [instanceId] as any);
    await logEvent(c, { projet_id: projetId, user_id: userId, action: 'instance_restauree', entite: 'instance', entite_id: instanceId, details: { stage: inst.stage } });
    await notifyCounters(projetId);
  });
}

// Purge automatique des instances en corbeille depuis plus de N jours.
export async function purgeTrash(retentionDays = config.trashRetentionDays) {
  const r = await query(
    `DELETE FROM instance WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 || ' days')::interval RETURNING id`,
    [String(retentionDays)]);
  return r.rowCount;
}

export { stageOf, openItem, refillReserve };
