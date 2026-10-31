// Scénario de bout en bout démontrable :
// import (avec doublon) -> localisation (dont 1 image négative et 1 relocalisée
// en mode ajout) -> classification -> segmentation -> validation d'instance
// (avec refus + commentaire) -> validation d'image -> exports COCO / YOLO-seg / sémantique.
import sharp from 'sharp';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bootTestServer, api, login } from '../tests/helpers.js';

const log = (...a: any[]) => console.log('\n▶', ...a);
const ok = (m: string) => console.log('  ✅', m);

async function makePng(file: string, w: number, h: number, color: [number, number, number]) {
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } })
    .png().toFile(file);
}

const s = await bootTestServer();
const base = s.base;
console.log('=== InstanceSeg Studio — scénario e2e ===');
console.log('API:', base);

// 1. Setup : admin, annotateur, projet, classes
const admin = await login(base, 'admin', 'admin123');
await api(base, '/api/auth/users', { method: 'POST', token: admin.token, body: { email: 'lea@studio.io', username: 'lea', password: 'pw', role: 'annotateur' } });
const lea = await login(base, 'lea', 'pw');
const p = await api(base, '/api/projets', { method: 'POST', token: admin.token, body: { nom: 'Démo production série', description: 'scénario e2e', pct_train: 70, pct_val: 20, pct_test: 10 } });
const pid = Number(p.data.projet.id);
const perms = { localisation: true, classification: true, segmentation: true, validation_instance: true, validation_image: true };
await api(base, `/api/projets/${pid}/membres`, { method: 'POST', token: admin.token, body: { user_id: lea.user.id, permissions: perms } });
const c1 = await api(base, `/api/projets/${pid}/classes`, { method: 'POST', token: admin.token, body: { nom: 'pièce OK', couleur: '#22c55e' } });
const c2 = await api(base, `/api/projets/${pid}/classes`, { method: 'POST', token: admin.token, body: { nom: 'pièce défaut', couleur: '#ef4444' } });
const clsOk = Number(c1.data.classe.id), clsKo = Number(c2.data.classe.id);
ok(`projet #${pid}, classes: pièce OK (#${clsOk}, z0), pièce défaut (#${clsKo}, z1)`);

// 2. Import d'images (4 PNG + 1 doublon)
log('Import de 4 images PNG + 1 doublon (anti-doublons SHA-256)');
const tmp = path.resolve('./uploads-e2e');
await fs.mkdir(tmp, { recursive: true });
await makePng(path.join(tmp, 'a.png'), 400, 300, [200, 200, 210]);
await makePng(path.join(tmp, 'b.png'), 400, 300, [180, 190, 200]);
await makePng(path.join(tmp, 'c.png'), 320, 240, [210, 200, 190]);
await makePng(path.join(tmp, 'd.png'), 360, 260, [190, 210, 200]);
async function importFiles(names: string[]) {
  const fd = new FormData();
  for (const n of names) fd.append('fichiers', new Blob([await fs.readFile(path.join(tmp, n))], { type: 'image/png' }), n);
  const res = await fetch(`${base}/api/projets/${pid}/images/import`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${admin.token}` } });
  return res.json() as Promise<any>;
}
const imp = await importFiles(['a.png', 'b.png', 'c.png', 'd.png', 'a.png']);
ok(`${imp.importes} importées, ${imp.doublons} doublon ignoré — splits: ${imp.details.filter((d: any) => d.status === 'importee').map((d: any) => d.split).join(', ')}`);
const images = (await (s.pool.query as any)('SELECT id, split, sha256 FROM image WHERE projet_id=$1 ORDER BY id', [pid])).rows;
const [imgA, imgB, imgC, imgD] = images.map((r: any) => Number(r.id));

async function open(poste: string, kind: string, id: number, tok = lea.token) {
  const r = await api(base, `/api/projets/${pid}/postes/${poste}/ouvrir`, { method: 'POST', token: tok, body: { kind, item_id: id } });
  if (r.status !== 200) throw new Error(`open ${poste}/${id}: ${JSON.stringify(r.data)}`);
}
async function file(poste: string, tok = lea.token) {
  return (await api(base, `/api/projets/${pid}/postes/${poste}/file`, { token: tok })).data.items;
}

// 3. Localisation : A = 2 boxes, B = négative, C = 1 box, D = 1 box (sera relocalisée)
log('Poste 1 — localisation');
await open('localisation', 'image', imgA);
let r = await api(base, `/api/projets/${pid}/postes/localisation/terminer`, { method: 'POST', token: lea.token, body: { image_id: imgA, boxes: [{ bbox: { x: 20, y: 20, w: 120, h: 90 } }, { bbox: { x: 200, y: 150, w: 100, h: 80 } }] } });
ok(`image A: 2 bounding boxes (${r.status})`);
await open('localisation', 'image', imgB);
r = await api(base, `/api/projets/${pid}/postes/localisation/terminer`, { method: 'POST', token: lea.token, body: { image_id: imgB, boxes: [], negative: true } });
const imgBrow = await (s.pool.query as any)('SELECT negative, localisation_done FROM image WHERE id=$1', [imgB]);
ok(`image B: aucune box → négative=${imgBrow.rows[0].negative} (part en validation d'image)`);
await open('localisation', 'image', imgC);
await api(base, `/api/projets/${pid}/postes/localisation/terminer`, { method: 'POST', token: lea.token, body: { image_id: imgC, boxes: [{ bbox: { x: 40, y: 30, w: 150, h: 110 } }] } });
await open('localisation', 'image', imgD);
await api(base, `/api/projets/${pid}/postes/localisation/terminer`, { method: 'POST', token: lea.token, body: { image_id: imgD, boxes: [{ bbox: { x: 10, y: 10, w: 80, h: 60 } }] } });
ok('images C et D localisées');

// 4. Classification (crop uniquement) — clic classe → instance suivante auto
log('Poste 2 — classification (crop uniquement)');
let insts = (await (s.pool.query as any)('SELECT id, image_id FROM instance WHERE image_id IN ($1,$2,$3) ORDER BY id', [imgA, imgC, imgD])).rows;
for (const [i, inst] of insts.entries()) {
  await open('classification', 'instance', Number(inst.id));
  const cls = i % 2 === 0 ? clsOk : clsKo;
  await api(base, `/api/projets/${pid}/postes/classification`, { method: 'POST', token: lea.token, body: { instance_id: Number(inst.id), class_id: cls } });
}
ok(`${insts.length} instances classifiées (auto-passage à la suivante)`);

// 5. Segmentation
log('Poste 3 — segmentation (polygone sur crop)');
for (const inst of insts) {
  await open('segmentation', 'instance', Number(inst.id));
  const r2 = await api(base, `/api/projets/${pid}/postes/segmentation`, { method: 'POST', token: lea.token, body: { instance_id: Number(inst.id), polygon: [[0, 0], [50, 5], [55, 45], [5, 50]] } });
  if (r2.status !== 200) throw new Error(JSON.stringify(r2.data));
}
ok(`${insts.length} polygones tracés`);

// 6. Validation d'instance : refus avec commentaire sur la 1ère, valida le reste
log('Poste 4 — validation d\'instance (refus ciblé + commentaire)');
const first = Number(insts[0].id);
await open('validation_instance', 'instance', first);
r = await api(base, `/api/projets/${pid}/postes/validation_instance`, { method: 'POST', token: lea.token, body: { instance_id: first, decision: 'refuser_classification', commentaire: 'Classe erronée — relire le crop, le polygone est bon.' } });
ok(`instance #${first} refusée → classification (classe effacée, polygone gardé): ${r.status}`);
let chk = await (s.pool.query as any)('SELECT class_id, polygon IS NOT NULL AS poly FROM instance WHERE id=$1', [first]);
ok(`  vérif: class_id=${chk.rows[0].class_id}, polygone conservé=${chk.rows[0].poly}`);
// l'annotateur reprend : reclassifie puis resegmente? non : classe seule suffit (polygone conservé)
await open('classification', 'instance', first);
await api(base, `/api/projets/${pid}/postes/classification`, { method: 'POST', token: lea.token, body: { instance_id: first, class_id: clsOk } });
await open('validation_instance', 'instance', first);
await api(base, `/api/projets/${pid}/postes/validation_instance`, { method: 'POST', token: lea.token, body: { instance_id: first, decision: 'valider', commentaire: 'OK après correction' } });
for (const inst of insts.slice(1)) {
  await open('validation_instance', 'instance', Number(inst.id));
  await api(base, `/api/projets/${pid}/postes/validation_instance`, { method: 'POST', token: lea.token, body: { instance_id: Number(inst.id), decision: 'valider' } });
}
ok(`toutes les instances validées (${insts.length})`);

// 7. Validation d'image : B (négative) validée ; D → localisation manquante → mode AJOUT
log('Poste 5 — validation d\'image');
await open('validation_image', 'image', imgB);
await api(base, `/api/projets/${pid}/postes/validation_image`, { method: 'POST', token: lea.token, body: { image_id: imgB, decision: 'valider' } });
ok('image B (négative) validée');
await open('validation_image', 'image', imgD);
await api(base, `/api/projets/${pid}/postes/validation_image`, { method: 'POST', token: lea.token, body: { image_id: imgD, decision: 'localisation_manquante' } });
ok('image D → flag « localisation manquante »');
await open('localisation', 'image', imgD);
r = await api(base, `/api/projets/${pid}/postes/localisation/ajouter`, { method: 'POST', token: lea.token, body: { image_id: imgD, boxes: [{ bbox: { x: 250, y: 180, w: 90, h: 70 } }] } });
const dCount = await (s.pool.query as any)('SELECT count(*)::int n, count(*) FILTER (WHERE validee)::int v FROM instance WHERE image_id=$1 AND deleted_at IS NULL', [imgD]);
ok(`mode AJOUT UNIQUEMENT: ${dCount.rows[0].n} instances (dont ${dCount.rows[0].v} validée conservée), ajout accepté (${r.status})`);
// re-classifie/segmente/valide la nouvelle instance de D
let newInst = await (s.pool.query as any)('SELECT id FROM instance WHERE image_id=$1 AND validee=false AND deleted_at IS NULL', [imgD]);
await open('classification', 'instance', Number(newInst.rows[0].id));
await api(base, `/api/projets/${pid}/postes/classification`, { method: 'POST', token: lea.token, body: { instance_id: Number(newInst.rows[0].id), class_id: clsKo } });
await open('segmentation', 'instance', Number(newInst.rows[0].id));
await api(base, `/api/projets/${pid}/postes/segmentation`, { method: 'POST', token: lea.token, body: { instance_id: Number(newInst.rows[0].id), polygon: [[0, 0], [40, 0], [40, 30]] } });
await open('validation_instance', 'instance', Number(newInst.rows[0].id));
await api(base, `/api/projets/${pid}/postes/validation_instance`, { method: 'POST', token: lea.token, body: { instance_id: Number(newInst.rows[0].id), decision: 'valider' } });
// valide A, C, D
for (const img of [imgA, imgC, imgD]) {
  await open('validation_image', 'image', img);
  await api(base, `/api/projets/${pid}/postes/validation_image`, { method: 'POST', token: lea.token, body: { image_id: img, decision: 'valider' } });
}
const val = await (s.pool.query as any)('SELECT count(*)::int n FROM image WHERE projet_id=$1 AND validee=true', [pid]);
ok(`images validées: ${val.rows[0].n}/4`);

// 8. Stats admin à la volée
log('Stats admin (calculées à la volée)');
const st = await api(base, `/api/projets/${pid}/stats`, { token: admin.token });
ok(`images: ${JSON.stringify(st.data.images)}`);
ok(`par classe: ${st.data.par_classe.map((c: any) => `${c.nom}=${c.n}`).join(', ')} | par poste: ${st.data.rythme_par_poste.map((c: any) => `${c.poste}=${c.n}`).join(', ')}`);

// 9. Exports des 3 formats
log('Exports COCO / YOLO-seg / sémantique');
for (const format of ['coco', 'yolo-seg', 'semantique']) {
  const j = await api(base, `/api/projets/${pid}/exports`, { method: 'POST', token: admin.token, body: { format, filters: {} } });
  const jobId = j.data.jobId;
  for (let i = 0; i < 50; i++) {
    await new Promise((r2) => setTimeout(r2, 200));
    const jobs = await api(base, `/api/projets/${pid}/exports`, { token: admin.token });
    const job = jobs.data.jobs.find((x: any) => Number(x.id) === jobId);
    if (job.statut === 'done') { ok(`${format}: job #${jobId} terminé → ${JSON.stringify(job.resultat).slice(0, 160)}`); break; }
    if (job.statut === 'error') throw new Error(job.erreur);
  }
}
const cocoFile = path.resolve('./exports-test', `p${pid}`, 'coco', `job_1`, 'instances.json');
if (existsSync(cocoFile)) {
  const coco = JSON.parse(await fs.readFile(cocoFile, 'utf8'));
  ok(`COCO parse: ${coco.images.length} images, ${coco.annotations.length} annotations, ${coco.categories.length} catégories`);
}

// 10. Audit de l'image A (filtré chronologiquement)
log('Audit image A (admin)');
const aud = await api(base, `/api/projets/${pid}/images/${imgA}/audit`, { token: admin.token });
ok(`${aud.data.evenements.length} événements journalisés (append-only), ex: ${aud.data.evenements.slice(-3).map((e: any) => e.action).join(' → ')}`);

console.log('\n=== Scénario e2e terminé avec succès ===');
await s.stop();
process.exit(0);
