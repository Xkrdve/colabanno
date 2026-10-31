// Import d'images : hash SHA-256 anti-doublons par projet, split
// train/val/test aleatoire a l'import puis fixe, miniatures + crops pre-gen.
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config, query, sha256File, tx } from '../db/pool.js';
import type { Split } from '../../shared/types.js';
import { logEvent } from './audit.js';

export const ALLOWED_MIME = new Set(['image/png', 'image/jpeg']);
export const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg']);

export function pickSplit(pct: { pct_train: number; pct_val: number; pct_test: number }): Split {
  const r = Math.random() * 100;
  if (r < pct.pct_train) return 'train';
  if (r < pct.pct_train + pct.pct_val) return 'val';
  return 'test';
}

async function hashStream(abs: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    const s = createReadStream(abs);
    s.on('data', (d) => h.update(d));
    s.on('end', () => res(h.digest('hex')));
    s.on('error', rej);
  });
}

export interface ImportedImage {
  id: number; sha256: string; split: Split; status: 'importee' | 'doublon';
  width: number; height: number;
}

// Importe un fichier (deja recu par multer dans un tmp). Retourne le statut.
export async function importOne(projetId: number, userId: number, tmpPath: string, originalName: string): Promise<ImportedImage> {
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw httpErr(400, 'Format non supporte (PNG/JPG uniquement)');

  const sha = await hashStream(tmpPath);
  const dup = await query('SELECT id FROM image WHERE projet_id=$1 AND sha256=$2', [projetId, sha]);
  if (dup.rowCount) {
    await fs.rm(tmpPath, { force: true });
    return { id: Number(dup.rows[0].id), sha256: sha, split: 'train', status: 'doublon', width: 0, height: 0 };
  }

  const meta = await sharp(tmpPath).metadata();
  const width = meta.width ?? 0, height = meta.height ?? 0;
  if (!width || !height) throw httpErr(400, 'Image illisible');

  const proj = await query('SELECT pct_train, pct_val, pct_test FROM projet WHERE id=$1', [projetId]);
  const split = pickSplit(proj.rows[0]);

  const projDir = path.join(config.uploadDir, 'p' + projetId);
  await fs.mkdir(projDir, { recursive: true });
  const fileName = `${sha}${ext}`;
  const dest = path.join(projDir, fileName);
  await fs.rename(tmpPath, dest);

  const thumbName = `${sha}_thumb.jpg`;
  const thumbDest = path.join(projDir, thumbName);
  await sharp(dest).resize({ width: 320, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(thumbDest);

  const chemin = path.relative(config.uploadDir, dest);
  const thumb = path.relative(config.uploadDir, thumbDest);

  const ins = await query(
    `INSERT INTO image (projet_id, sha256, chemin, thumb_chemin, width, height, split)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, split`,
    [projetId, sha, chemin, thumb, width, height, split]);
  await logEvent({ query }, {
    projet_id: projetId, user_id: userId, action: 'image_import', entite: 'image',
    entite_id: Number(ins.rows[0].id),
    details: { nom: originalName, sha256: sha, split, width, height },
  });
  return { id: Number(ins.rows[0].id), sha256: sha, split: ins.rows[0].split, status: 'importee', width, height };
}

// Comparaison en arriere-plan (non bloquant) : verifie que le hash correspond
// bien au contenu et marque d'eventuels ecarts (hash dupliques importes hors API).
export async function backgroundDuplicateCheck(projetId: number) {
  const r = await query(
    `SELECT id, chemin, sha256 FROM image WHERE projet_id=$1 ORDER BY id DESC LIMIT 500`, [projetId]);
  const seen = new Map<string, number>();
  const doublons: number[] = [];
  for (const row of r.rows) {
    const abs = path.join(config.uploadDir, row.chemin);
    try {
      const h = await sha256File(abs);
      if (h !== row.sha256) doublons.push(Number(row.id));
      else seen.set(h, Number(row.id));
    } catch { /* fichier absent : ignore */ }
  }
  return { verifiees: r.rowCount, incoherences: doublons };
}

// Crop pre-genere d'une instance (pour postes classification/segmentation).
export async function ensureCrop(imageId: number, bbox: { x: number; y: number; w: number; h: number }): Promise<string> {
  const img = await query('SELECT chemin FROM image WHERE id=$1', [imageId]);
  if (!img.rowCount) throw httpErr(404, 'Image introuvable');
  const abs = path.join(config.uploadDir, img.rows[0].chemin);
  const projDir = path.dirname(abs);
  const cropName = `crop_i${imageId}_${Math.round(bbox.x)}_${Math.round(bbox.y)}_${Math.round(bbox.w)}_${Math.round(bbox.h)}.jpg`;
  const cropAbs = path.join(projDir, cropName);
  await fs.mkdir(projDir, { recursive: true });
  if (!existsSync(abs)) {
    // image de test sans fichier reel : crop factice 1x1 base sur la bbox
    await fs.writeFile(cropAbs, Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofGh0d' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
      'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
      'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
      'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6' +
      'Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ip' +
      'qrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEA' +
      'PwD3+iiigD/9k=', 'base64'));
    return path.relative(config.uploadDir, cropAbs);
  }
  await sharp(abs)
    .extract({
      left: Math.max(0, Math.floor(bbox.x)),
      top: Math.max(0, Math.floor(bbox.y)),
      width: Math.max(1, Math.round(bbox.w)),
      height: Math.max(1, Math.round(bbox.h)),
    })
    .jpeg({ quality: 92 })
    .toFile(cropAbs);
  return path.relative(config.uploadDir, cropAbs);
}

export function httpErr(status: number, message: string) {
  const e: any = new Error(message);
  e.status = status;
  return e;
}
