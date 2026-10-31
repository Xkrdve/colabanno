// Validation des exports COCO et YOLO-seg par un parseur independant :
// structure JSON, cohérence ids, coordonnées normalisées YOLO, splits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootTestServer, api, login } from './helpers.js';

let s: Awaited<ReturnType<typeof bootTestServer>>;
let buildCoco: any, buildYoloSeg: any, buildSemantique: any;
let base: string;
let projetId: number;

before(async () => {
  s = await bootTestServer();
  base = s.base;
  // import APRES bootTestServer pour que DATABASE_URL soit positionne
  ({ buildCoco, buildYoloSeg, buildSemantique } = await import('../src/server/services/exports.js'));
  const admin = await login(base, 'admin', 'admin123');
  const p = await api(base, '/api/projets', { method: 'POST', token: admin.token, body: { nom: 'P-exports', pct_train: 70, pct_val: 20, pct_test: 10 } });
  projetId = Number(p.data.projet.id);
  // 2 classes avec z-index
  const c1 = await api(base, `/api/projets/${projetId}/classes`, { method: 'POST', token: admin.token, body: { nom: 'chat', couleur: '#f00' } });
  const c2 = await api(base, `/api/projets/${projetId}/classes`, { method: 'POST', token: admin.token, body: { nom: 'chien', couleur: '#0f0' } });
  const chatId = Number(c1.data.classe.id), chienId = Number(c2.data.classe.id);
  // 3 images validées avec instances complètes
  for (let i = 0; i < 3; i++) {
    const split = ['train', 'val', 'test'][i];
    const ins = await (s.pool.query as any)(
      `INSERT INTO image (projet_id, sha256, chemin, thumb_chemin, width, height, split, negative, localisation_done, validee)
       VALUES ($1,$2,$3,NULL,200,100,$4,false,true,true) RETURNING id`,
      [projetId, 'shaexp' + i, `p${projetId}/img${i}.png`, split]);
    const imageId = Number(ins.rows[0].id);
    const cls = i === 2 ? chienId : chatId;
    await (s.pool.query as any)(
      `INSERT INTO instance (image_id, bbox, class_id, polygon, validee, created_by)
       VALUES ($1, $2, $3, $4, true, 1)`,
      [imageId, JSON.stringify({ x: 10 + i, y: 10, w: 50, h: 40 }),
       cls, JSON.stringify([[10 + i, 10], [60 + i, 10], [60 + i, 50], [10 + i, 50]])]);
  }
});

after(async () => { await s.stop(); });

test('COCO : structure valide et parseable, ids coherents, bbox/segmentation présents', async () => {
  const coco = await buildCoco(projetId, {});
  // parseur independant : re-serialisation + verifications de contrat COCO
  const json = JSON.parse(JSON.stringify(coco));
  assert.ok(json.info && json.images && json.annotations && json.categories, 'champs racines COCO');
  assert.equal(json.images.length, 3);
  assert.equal(json.annotations.length, 3);
  assert.equal(json.categories.length, 2);
  const catIds = new Set(json.categories.map((c: any) => c.id));
  const imageIds = new Set(json.images.map((i: any) => i.id));
  let prev = 0;
  for (const a of json.annotations) {
    assert.ok(a.id > prev, 'ids d\u2019annotation croissants'); prev = a.id;
    assert.ok(imageIds.has(a.image_id), 'image_id reference une image existante');
    assert.ok(catIds.has(a.category_id), 'category_id reference une categorie existante');
    assert.ok(Array.isArray(a.bbox) && a.bbox.length === 4, 'bbox [x,y,w,h]');
    assert.ok(a.bbox[2] > 0 && a.bbox[3] > 0, 'bbox w/h > 0');
    assert.ok(a.area > 0, 'area > 0');
    assert.ok(Array.isArray(a.segmentation) && a.segmentation.length === 1, 'segmentation = 1 polygone');
    const flat = a.segmentation[0];
    assert.ok(flat.length >= 6 && flat.length % 2 === 0, 'polygone plat pair');
    for (const v of flat) assert.ok(v >= 0 && v <= 200 || v <= 100, 'coordonnees dans l\u2019image');
    assert.equal(a.iscrowd, 0);
  }
  // filtre par classe
  const cocoChat = await buildCoco(projetId, { classIds: [1] });
  assert.equal(cocoChat.annotations.length, 2, 'filtre classe chat = 2 instances');
  // filtre par split
  const cocoTrain = await buildCoco(projetId, { splits: ['train'] });
  assert.equal(cocoTrain.images.length, 1);
  assert.equal(cocoTrain.annotations.length, 1);
});

test('YOLO-seg : labels normalises [0,1], classe en tête, un fichier par image, splits respectes', async () => {
  const y = await buildYoloSeg(projetId, {});
  assert.deepEqual(y.classes.sort(), ['chat', 'chien']);
  for (const split of ['train', 'val', 'test'] as const) {
    const sp = y.splits[split];
    assert.equal(sp.images.length, 1, `1 image en ${split}`);
    const labels = Object.values(sp.labels) as string[][];
    assert.equal(labels.length, 1);
    const lines = labels[0];
    assert.equal(lines.length, 1);
    const parts = lines[0].trim().split(/\s+/).map(Number);
    assert.ok(Number.isInteger(parts[0]) && parts[0] >= 0 && parts[0] < y.classes.length, 'class index valide');
    assert.ok((parts.length - 1) % 2 === 0 && parts.length >= 7, 'polygone seg (>=3 points) ou bbox (4 valeurs)');
    for (let i = 1; i < parts.length; i++) {
      assert.ok(parts[i] >= 0 && parts[i] <= 1, `coordonnee normalisee dans [0,1]: ${parts[i]}`);
    }
  }
  // filtre classe chien => seules les images avec chien ont un label non vide
  const yChien = await buildYoloSeg(projetId, { classIds: [2] });
  const totalLabels = Object.values(yChien.splits).flatMap((sp: any) => Object.values(sp.labels) as string[][]).flat().length;
  assert.equal(totalLabels, 1, '1 seule instance chien exportee');
});

test('Semantique : masque PNG genere, dimensions = image, classes par z-index', async () => {
  const r = await buildSemantique(projetId, {});
  assert.equal(r.images.length, 3);
  assert.equal(r.classes.length, 2);
  const z = r.classes.map((c: any) => c.z_index);
  assert.deepEqual([...z].sort((a, b) => a - b), z, 'z-index croissants = ordre de palette');
  for (const im of r.images) {
    const abs = path.join(process.env.EXPORT_DIR || './exports-test', `p${projetId}`, im.masque);
    assert.ok(fs.existsSync(abs), `masque existe: ${abs}`);
    const buf = fs.readFileSync(abs);
    assert.equal(buf.readUInt32BE(0), 0x89504e47, 'signature PNG');
  }
});

test('filtre par periode (from/to) sur created_at des images', async () => {
  const coco = await buildCoco(projetId, { from: '2999-01-01' });
  assert.equal(coco.images.length, 0, 'aucune image apres 2999');
  const cocoAll = await buildCoco(projetId, { to: '2999-01-01' });
  assert.equal(cocoAll.images.length, 3);
});
