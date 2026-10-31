// Files par poste : reservation de 50 items par annotateur/poste, ordre
// aleatoire, verrou par ligne reservation (un item ouvert = invisible ailleurs).
import type { PoolClient } from 'pg';
import { config, query, tx } from '../db/pool.js';
import type { Poste, QueueItem } from '../../shared/types.js';
import { logEvent } from './audit.js';
import { broadcastCounters } from '../ws.js';

type Q = { query: (t: string, p?: any[]) => Promise<any> };

export const RESERVE_SIZE = config.reserveSize;

// Items eligibles (non reservees par qui que ce soit) pour un poste.
const ELIGIBLE: Record<Poste, { kind: 'image' | 'instance'; sql: string }> = {
  localisation: {
    kind: 'image',
    sql: `SELECT i.id, i.id AS image_id FROM image i
      WHERE i.projet_id=$1 AND i.localisation_done=FALSE`,
  },
  classification: {
    kind: 'instance',
    sql: `SELECT x.id, x.image_id FROM instance x JOIN image i ON i.id=x.image_id
      WHERE i.projet_id=$1 AND x.deleted_at IS NULL AND x.validee=FALSE
        AND x.bbox IS NOT NULL AND x.class_id IS NULL`,
  },
  segmentation: {
    kind: 'instance',
    sql: `SELECT x.id, x.image_id FROM instance x JOIN image i ON i.id=x.image_id
      WHERE i.projet_id=$1 AND x.deleted_at IS NULL AND x.validee=FALSE
        AND x.bbox IS NOT NULL AND x.class_id IS NOT NULL AND x.polygon IS NULL`,
  },
  validation_instance: {
    kind: 'instance',
    sql: `SELECT x.id, x.image_id FROM instance x JOIN image i ON i.id=x.image_id
      WHERE i.projet_id=$1 AND x.deleted_at IS NULL AND x.validee=FALSE
        AND x.bbox IS NOT NULL AND x.class_id IS NOT NULL AND x.polygon IS NOT NULL`,
  },
  validation_image: {
    kind: 'image',
    sql: `SELECT i.id, i.id AS image_id FROM image i
      WHERE i.projet_id=$1 AND i.validee=FALSE AND i.localisation_done=TRUE
        AND ( i.negative=TRUE
              OR ( EXISTS (SELECT 1 FROM instance x WHERE x.image_id=i.id AND x.deleted_at IS NULL)
                   AND NOT EXISTS (SELECT 1 FROM instance x WHERE x.image_id=i.id
                                   AND x.deleted_at IS NULL AND x.validee=FALSE) ) )`,
  },
};

async function eligibleCount(q: Q, projetId: number, poste: Poste): Promise<number> {
  const e = ELIGIBLE[poste];
  const r = await q.query(
    `SELECT count(*)::int AS n FROM (${e.sql}) t
     WHERE NOT EXISTS (SELECT 1 FROM reservation r WHERE r.item_kind=$2 AND r.item_id=t.id)`,
    [projetId, e.kind]);
  return r.rows[0].n;
}

// Re-complete la reserve de l'utilisateur a RESERVE_SIZE (tirage aleatoire,
// en excluant tout item deja reserve, meme par lui-meme ailleurs).
export async function refillReserve(q: Q, projetId: number, userId: number, poste: Poste): Promise<void> {
  const e = ELIGIBLE[poste];
  await q.query(
    `INSERT INTO reservation (projet_id, poste, item_kind, item_id, user_id, ordre)
     SELECT $1, $2, $3, t.id, $4, random()
     FROM (${e.sql}) t
     WHERE NOT EXISTS (SELECT 1 FROM reservation r WHERE r.item_kind=$3 AND r.item_id=t.id)
     ORDER BY random()
     LIMIT GREATEST(0, $5 - (SELECT count(*) FROM reservation WHERE user_id=$4 AND poste=$2))
     ON CONFLICT (item_kind, item_id) DO NOTHING`,
    [projetId, poste, e.kind, userId, RESERVE_SIZE]);
}

// Liste la file de l'utilisateur pour un poste (ses reservations encore
// eligibles), ordonnee aleatoirement + compteurs globaux.
export async function listQueue(q: Q, projetId: number, userId: number, poste: Poste): Promise<QueueItem[]> {
  await refillReserve(q, projetId, userId, poste);
  const e = ELIGIBLE[poste];
  const r = await q.query(
    `SELECT r.item_kind AS kind, r.item_id AS id, r.user_id AS locked_by,
            u.username AS locked_by_username,
            i.id AS image_id, i.width, i.height, i.chemin, i.thumb_chemin AS thumb,
            i.negative, i.localisation_done, i.relocalisation_ajout, i.validee AS image_validee,
            x.id AS inst_id, x.bbox, x.class_id, x.polygon, x.crop_chemin, x.validee AS inst_validee,
            x.deleted_at, x.created_by, x.created_at AS inst_created, x.updated_at AS inst_updated,
            instance_stage(x) AS stage,
            c.nom AS class_nom, c.couleur
     FROM reservation r
     JOIN image i ON i.id = (CASE WHEN r.item_kind='image' THEN r.item_id ELSE
        (SELECT image_id FROM instance WHERE id=r.item_id) END)
     LEFT JOIN instance x ON r.item_kind='instance' AND x.id=r.item_id
     LEFT JOIN classe c ON c.id = x.class_id
     LEFT JOIN utilisateur u ON u.id = r.user_id
     WHERE r.projet_id=$1 AND r.poste=$2 AND r.user_id=$3
       AND EXISTS (SELECT 1 FROM (${e.sql}) t WHERE t.id = r.item_id)  -- l'item est toujours eligible
     ORDER BY r.ordre`,
    [projetId, poste, userId]);
  const total = await query(
    `SELECT (SELECT count(*) FROM (${e.sql}) t
      WHERE NOT EXISTS (SELECT 1 FROM reservation r WHERE r.item_kind=$3 AND r.item_id=t.id))::int
      + (SELECT count(*) FROM reservation WHERE projet_id=$1 AND poste=$2) AS n`,
    [projetId, poste, e.kind]);
  const mine = r.rowCount;
  const count_total = total.rows[0].n;
  return r.rows.map((row: any) => ({
    kind: row.kind,
    id: Number(row.id),
    image_id: Number(row.image_id),
    locked_by_me: true,
    locked_by: Number(row.locked_by),
    locked_by_username: row.locked_by_username,
    width: row.width, height: row.height, chemin: row.chemin, thumb: row.thumb,
    negative: row.negative,
    count_total,
    count_mine: mine,
    instance: row.inst_id ? {
      id: Number(row.inst_id), image_id: Number(row.image_id),
      bbox: row.bbox, class_id: row.class_id ? Number(row.class_id) : null,
      polygon: row.polygon, crop_chemin: row.crop_chemin,
      validee: row.inst_validee, deleted_at: row.deleted_at,
      created_by: row.created_by ? Number(row.created_by) : null,
      created_at: row.inst_created, updated_at: row.inst_updated,
      stage: row.stage, class_nom: row.class_nom, couleur: row.couleur,
    } : undefined,
  }));
}

// Ouvre (verrouille) un item : reservation atomique, sinon 409.
export async function openItem(q: Q, projetId: number, userId: number, poste: Poste,
                               kind: 'image' | 'instance', itemId: number) {
  const r = await q.query(
    `INSERT INTO reservation (projet_id, poste, item_kind, item_id, user_id, ordre)
     VALUES ($1,$2,$3,$4,$5,random())
     ON CONFLICT (item_kind, item_id) DO NOTHING
     RETURNING id, user_id`,
    [projetId, poste, kind, itemId, userId]);
  if (!r.rowCount) {
    const existing = await q.query(
      'SELECT user_id::text AS user_id, u.username FROM reservation r JOIN utilisateur u ON u.id=r.user_id WHERE r.item_kind=$1 AND r.item_id=$2',
      [kind, itemId]);
    if (existing.rowCount && String(existing.rows[0].user_id) === String(userId)) {
      const again = await q.query('SELECT id FROM reservation WHERE item_kind=$1 AND item_id=$2', [kind, itemId]);
      return Number(again.rows[0].id); // deja verrouille par moi : idempotent
    }
    const err: any = new Error('Item verrouille par un autre annotateur');
    err.code = 'LOCKED';
    err.status = 409;
    err.locked_by = existing.rows[0]?.username ?? null;
    throw err;
  }
  return r.rows[0].id;
}

// Libere un item (termine) puis re-complete la reserve.
export async function releaseItem(q: Q, projetId: number, userId: number, poste: Poste,
                                  kind: 'image' | 'instance', itemId: number) {
  await q.query('DELETE FROM reservation WHERE item_kind=$1 AND item_id=$2 AND user_id=$3', [kind, itemId, userId]);
  await refillReserve(q, projetId, userId, poste);
}

export async function counters(projetId: number, poste: Poste) {
  const e = ELIGIBLE[poste];
  const r = await query(
    `SELECT count(*)::int AS disponibles FROM (${e.sql}) t
     WHERE NOT EXISTS (SELECT 1 FROM reservation r WHERE r.item_kind=$2 AND r.item_id=t.id)`,
    [projetId, e.kind]);
  const v = await query('SELECT count(*)::int AS verrouilles FROM reservation WHERE projet_id=$1 AND poste=$2', [projetId, poste]);
  return { poste, disponibles: r.rows[0].disponibles, verrouilles: v.rows[0].verrouilles };
}

export async function notifyCounters(projetId: number, poste?: Poste) {
  const postes = poste ? [poste] : (['localisation','classification','segmentation','validation_instance','validation_image'] as Poste[]);
  for (const p of postes) broadcastCounters(projetId, p, await counters(projetId, p));
}

export { logEvent };
export { tx };
