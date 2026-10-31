// Exports : COCO, YOLO-seg, segmentation semantique (aplat des instances,
// chevauchements tranches par z-index des classes).
// Filtres : classes, sous-ensemble d'images, periode. Splits respectes.
// Ecrits dans EXPORT_DIR par un worker en tache de fond.
import path from 'node:path';
import fs from 'node:fs/promises';
import { config, query, tx } from '../db/pool.js';
import type { Point } from '../../shared/types.js';
import { logEvent } from './audit.js';
import sharp from 'sharp';

export type ExportFormat = 'coco' | 'yolo-seg' | 'semantique';

export interface ExportFilters {
  classIds?: number[];
  imageIds?: number[];
  from?: string; to?: string; // periode sur created_at des images
  splits?: ('train' | 'val' | 'test')[];
}

function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]; const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

function bboxOf(pts: Point[]): { x: number; y: number; w: number; h: number } {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

async function loadDataset(projetId: number, f: ExportFilters) {
  const imgCond: string[] = ['i.projet_id=$1', 'i.validee=TRUE'];
  const params: any[] = [projetId];
  if (f.imageIds?.length) { params.push(f.imageIds); imgCond.push(`i.id = ANY($${params.length}::bigint[])`); }
  if (f.splits?.length) { params.push(f.splits); imgCond.push(`i.split::text = ANY($${params.length}::text[])`); }
  if (f.from) { params.push(f.from); imgCond.push(`i.created_at >= $${params.length}::timestamptz`); }
  if (f.to) { params.push(f.to); imgCond.push(`i.created_at <= $${params.length}::timestamptz`); }

  const images = await query(
    `SELECT i.id, i.chemin, i.width, i.height, i.split FROM image i
     WHERE ${imgCond.join(' AND ')} ORDER BY i.id`, params);
  const imageIds = images.rows.map((r) => Number(r.id));
  const inst = imageIds.length ? await query(
    `SELECT x.id, x.image_id, x.bbox, x.class_id, x.polygon FROM instance x
     WHERE x.image_id = ANY($1::bigint[]) AND x.deleted_at IS NULL AND x.validee=TRUE
       AND x.bbox IS NOT NULL
       ${f.classIds?.length ? `AND x.class_id = ANY($${params.length + 1}::bigint[])` : ''}
     ORDER BY x.id`,
    f.classIds?.length ? [imageIds, f.classIds] : [imageIds]) : { rows: [] as any[] };
  const classes = await query('SELECT id, nom, z_index, couleur FROM classe WHERE projet_id=$1 ORDER BY z_index', [projetId]);
  return { images: images.rows, instances: inst.rows, classes: classes.rows };
}

export async function buildCoco(projetId: number, f: ExportFilters) {
  const { images, instances, classes } = await loadDataset(projetId, f);
  const cats = classes
    .filter((c) => !f.classIds?.length || f.classIds.includes(Number(c.id)))
    .map((c, i) => ({ id: i + 1, name: c.nom, supercategory: 'instance' }));
  const catByDbId = new Map(classes.map((c, i) => [Number(c.id), i + 1]));
  const out = {
    info: { description: `Projet ${projetId}`, version: '1.0', date_created: new Date().toISOString() },
    licenses: [],
    images: images.map((im) => ({ id: Number(im.id), file_name: im.chemin, width: im.width, height: im.height, split: im.split })),
    annotations: [] as any[],
    categories: cats,
  };
  let annId = 1;
  for (const x of instances) {
    if (f.classIds?.length && !f.classIds.includes(Number(x.class_id))) continue;
    const bbox = x.bbox as { x: number; y: number; w: number; h: number };
    const poly = (x.polygon as Point[] | null) ?? [];
    out.annotations.push({
      id: annId++, image_id: Number(x.image_id), category_id: catByDbId.get(Number(x.class_id)),
      bbox: [bbox.x, bbox.y, bbox.w, bbox.h],
      area: poly.length >= 3 ? polygonArea(poly) : bbox.w * bbox.h,
      segmentation: poly.length >= 3 ? [poly.flat()] : [],
      iscrowd: 0,
    });
  }
  return out;
}

export async function buildYoloSeg(projetId: number, f: ExportFilters) {
  const { images, instances, classes } = await loadDataset(projetId, f);
  const keptClasses = classes.filter((c) => !f.classIds?.length || f.classIds.includes(Number(c.id)));
  const classIdx = new Map(keptClasses.map((c, i) => [Number(c.id), i]));
  const labels = new Map<number, string[]>();
  for (const im of images) labels.set(Number(im.id), []);
  for (const x of instances) {
    if (f.classIds?.length && !f.classIds.includes(Number(x.class_id))) continue;
    const ci = classIdx.get(Number(x.class_id));
    if (ci === undefined) continue;
    const poly = (x.polygon as Point[] | null);
    const im = images.find((i) => Number(i.id) === Number(x.image_id));
    if (!im) continue;
    let line: string;
    if (poly && poly.length >= 3) {
      const norm = poly.map(([px, py]) => `${(px / im.width).toFixed(6)} ${(py / im.height).toFixed(6)}`).join(' ');
      line = `${ci} ${norm}`;
    } else {
      const b = x.bbox as { x: number; y: number; w: number; h: number };
      const cx = (b.x + b.w / 2) / im.width, cy = (b.y + b.h / 2) / im.height;
      line = `${ci} ${cx.toFixed(6)} ${cy.toFixed(6)} ${(b.w / im.width).toFixed(6)} ${(b.h / im.height).toFixed(6)}`;
    }
    labels.get(Number(x.image_id))!.push(line);
  }
  return {
    classes: keptClasses.map((c) => c.nom),
    splits: Object.fromEntries(['train', 'val', 'test'].map((s) => [s, {
      images: images.filter((i) => i.split === s).map((i) => i.chemin),
      labels: Object.fromEntries(images.filter((i) => i.split === s).map((i) => [
        path.basename(i.chemin, path.extname(i.chemin)) + '.txt', labels.get(Number(i.id))!,
      ])),
    }])),
  };
}

// Segmentation semantique : masque PNG par image (aplat des instances,
// chevauchements tranches par z-index : la classe au z-index le plus haut gagne).
export async function buildSemantique(projetId: number, f: ExportFilters) {
  const { images, instances, classes } = await loadDataset(projetId, f);
  const zByClass = new Map(classes.map((c) => [Number(c.id), Number(c.z_index)]));
  const kept = classes.filter((c) => !f.classIds?.length || f.classIds.includes(Number(c.id)));
  const palette = new Map(kept.map((c, i) => [Number(c.id), i + 1])); // index couleur = rang z-index + 1
  const byImage = new Map<number, typeof instances>();
  for (const x of instances) {
    if (f.classIds?.length && !f.classIds.includes(Number(x.class_id))) continue;
    const k = Number(x.image_id);
    if (!byImage.has(k)) byImage.set(k, []);
    byImage.get(k)!.push(x);
  }
  const outDir = path.join(config.exportDir, `p${projetId}`, 'semantique');
  await fs.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const im of images) {
    const W = Number(im.width), H = Number(im.height);
    const mask = Buffer.alloc(W * H, 0);
    const list = (byImage.get(Number(im.id)) ?? [])
      .filter((x) => x.polygon)
      .sort((a, b) => (zByClass.get(Number(a.class_id)) ?? 0) - (zByClass.get(Number(b.class_id)) ?? 0));
    for (const x of list) {
      const color = palette.get(Number(x.class_id)) ?? 0;
      const pts = x.polygon as Point[];
      fillPolygon(mask, W, H, pts, color);
    }
    const png = await sharp(mask, { raw: { width: W, height: H, channels: 1 } })
      .png({ palette: true }).toBuffer();
    const base = path.basename(im.chemin).replace(/\.[^.]+$/, '');
    const name = `sem_${base}.png`;
    await fs.writeFile(path.join(outDir, name), png);
    written.push(path.join('semantique', name));
  }
  return {
    dossier: path.join(`p${projetId}`, 'semantique'),
    images: images.map((i) => ({ id: Number(i.id), split: i.split, masque: written[images.indexOf(i)] })),
    classes: kept.map((c, i) => ({ index_couleur: i + 1, nom: c.nom, z_index: c.z_index })),
  };
}

function fillPolygon(mask: Buffer, W: number, H: number, pts: Point[], color: number) {
  const ys = pts.map((p) => p[1]);
  const yMin = Math.max(0, Math.floor(Math.min(...ys)));
  const yMax = Math.min(H - 1, Math.ceil(Math.max(...ys)));
  for (let y = yMin; y <= yMax; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i]; const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i]));
      const x1 = Math.min(W - 1, Math.floor(xs[i + 1]));
      for (let x = x0; x <= x1; x++) mask[y * W + x] = color;
    }
  }
}

// ---------- Worker de taches de fond ----------
export async function runExportJob(jobId: number) {
  await tx(async (c) => {
    const j = await c.query('SELECT * FROM job WHERE id=$1 FOR UPDATE', [jobId]);
    if (!j.rowCount || j.rows[0].statut !== 'pending') return;
    await c.query("UPDATE job SET statut='running', updated_at=now() WHERE id=$1", [jobId]);
  });
  try {
    const j = await query('SELECT * FROM job WHERE id=$1', [jobId]);
    const { projet_id, payload } = j.rows[0];
    const format = payload.format as ExportFormat;
    const f: ExportFilters = payload.filters ?? {};
    const dir = path.join(config.exportDir, `p${projet_id}`, format, `job_${jobId}`);
    await fs.mkdir(dir, { recursive: true });
    let resultat: any;
    if (format === 'coco') {
      const coco = await buildCoco(projet_id, f);
      await fs.writeFile(path.join(dir, 'instances.json'), JSON.stringify(coco, null, 2));
      resultat = { fichier: path.join(`p${projet_id}`, format, `job_${jobId}`, 'instances.json'), annotations: coco.annotations.length, images: coco.images.length };
    } else if (format === 'yolo-seg') {
      const y = await buildYoloSeg(projet_id, f);
      await fs.writeFile(path.join(dir, 'dataset.yaml'), [
        `path: .`, `train: train/images`, `val: val/images`, `test: test/images`,
        `names: [${y.classes.map((c) => `'${c}'`).join(', ')}]`,
      ].join('\n'));
      for (const split of ['train', 'val', 'test'] as const) {
        const sdir = path.join(dir, split);
        await fs.mkdir(path.join(sdir, 'images'), { recursive: true });
        await fs.mkdir(path.join(sdir, 'labels'), { recursive: true });
        const sp = y.splits[split];
        for (const imgPath of sp.images) {
          await fs.copyFile(path.join(config.uploadDir, imgPath), path.join(sdir, 'images', path.basename(imgPath)));
        }
        for (const [labelName, lines] of Object.entries(sp.labels)) {
          await fs.writeFile(path.join(sdir, 'labels', labelName), lines.join('\n') + (lines.length ? '\n' : ''));
        }
      }
      resultat = { dossier: path.join(`p${projet_id}`, format, `job_${jobId}`), classes: y.classes };
    } else {
      resultat = await buildSemantique(projet_id, f);
    }
    await query("UPDATE job SET statut='done', resultat=$1, updated_at=now() WHERE id=$2",
      [JSON.stringify(resultat), jobId]);
    await logEvent({ query }, { projet_id, user_id: j.rows[0].user_id, action: 'export_realise', entite: 'job', entite_id: jobId, details: { format, ...resultat } });
  } catch (e: any) {
    await query("UPDATE job SET statut='error', erreur=$1, updated_at=now() WHERE id=$2", [String(e.message), jobId]);
  }
}

export async function enqueueExport(projetId: number, userId: number, format: ExportFormat, filters: ExportFilters) {
  const r = await query(
    `INSERT INTO job (type, projet_id, user_id, payload) VALUES ('export',$1,$2,$3) RETURNING id`,
    [projetId, userId, JSON.stringify({ format, filters })]);
  const id = Number(r.rows[0].id);
  setImmediate(() => runExportJob(id));
  return id;
}

export function startAutoExport(projetId: number, intervalMin: number) {
  if (intervalMin <= 0) return () => {};
  const t = setInterval(async () => {
    try {
      for (const format of ['coco', 'yolo-seg', 'semantique'] as ExportFormat[]) {
        await enqueueExport(projetId, null as any, format, {});
      }
    } catch { /* log */ }
  }, intervalMin * 60_000);
  t.unref?.();
  return () => clearInterval(t);
}
