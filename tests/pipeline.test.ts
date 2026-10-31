// Pipeline complet : stades calcules, refus cibles, negative, relocalisation
// en mode ajout, contestation -> corbeille, audit append-only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api, login } from './helpers.js';
import { stageOf } from '../src/shared/types.js';

let s: Awaited<ReturnType<typeof bootTestServer>>;
let base: string;
let admin: any, alice: any, projetId: number, chatId: number;

before(async () => {
  s = await bootTestServer();
  base = s.base;
  admin = await login(base, 'admin', 'admin123');
  await api(base, '/api/auth/users', { method: 'POST', token: admin.token, body: { email: 'alice@x.io', username: 'alice', password: 'pw', role: 'annotateur' } });
  alice = await login(base, 'alice', 'pw');
  const p = await api(base, '/api/projets', { method: 'POST', token: admin.token, body: { nom: 'P-pipe', pct_train: 100, pct_val: 0, pct_test: 0 } });
  projetId = Number(p.data.projet.id);
  const perms = { localisation: true, classification: true, segmentation: true, validation_instance: true, validation_image: true };
  await api(base, `/api/projets/${projetId}/membres`, { method: 'POST', token: admin.token, body: { user_id: alice.user.id, permissions: perms } });
  const c = await api(base, `/api/projets/${projetId}/classes`, { method: 'POST', token: admin.token, body: { nom: 'chat' } });
  chatId = Number(c.data.classe.id);
});

after(async () => { await s.stop(); });

async function addImage(sha: string) {
  const r = await (s.pool.query as any)(
    `INSERT INTO image (projet_id, sha256, chemin, thumb_chemin, width, height, split) VALUES ($1,$2,$3,NULL,400,300,'train') RETURNING id`,
    [projetId, sha, `p${projetId}/${sha}.png`]);
  return Number(r.rows[0].id);
}
async function open(poste: string, kind: string, id: number) {
  const r = await api(base, `/api/projets/${projetId}/postes/${poste}/ouvrir`, { method: 'POST', token: alice.token, body: { kind, item_id: id } });
  assert.equal(r.status, 200, `open ${poste} ${kind} ${id}: ${JSON.stringify(r.data)}`);
}

test('stade calcule jamais stocke : transitions localisee -> classifiee -> complete -> validee', async () => {
  assert.equal(stageOf({ bbox: { x: 0, y: 0, w: 1, h: 1 }, class_id: null, polygon: null, validee: false, deleted_at: null }), 'localisee');
  assert.equal(stageOf({ bbox: { x: 0, y: 0, w: 1, h: 1 }, class_id: 1, polygon: null, validee: false, deleted_at: null }), 'classifiee');
  assert.equal(stageOf({ bbox: { x: 0, y: 0, w: 1, h: 1 }, class_id: null, polygon: [[0, 0]], validee: false, deleted_at: null }), 'segmentee');
  assert.equal(stageOf({ bbox: { x: 0, y: 0, w: 1, h: 1 }, class_id: 1, polygon: [[0, 0]], validee: false, deleted_at: null }), 'complete');
  assert.equal(stageOf({ bbox: { x: 0, y: 0, w: 1, h: 1 }, class_id: 1, polygon: [[0, 0]], validee: true, deleted_at: null }), 'validee');
  assert.equal(stageOf({ bbox: null, class_id: null, polygon: null, validee: false, deleted_at: 'x' }), 'supprimee');

  const imgId = await addImage('pipe1');
  await open('localisation', 'image', imgId);
  const t = await api(base, `/api/projets/${projetId}/postes/localisation/terminer`, { method: 'POST', token: alice.token, body: { image_id: imgId, boxes: [{ bbox: { x: 10, y: 10, w: 100, h: 80 } }] } });
  assert.equal(t.status, 200);
  const inst = await (s.pool.query as any)('SELECT * FROM instance WHERE image_id=$1', [imgId]);
  assert.equal(inst.rows.length, 1);
  const id = Number(inst.rows[0].id);
  let stage = await (s.pool.query as any)('SELECT instance_stage(x) s FROM instance x WHERE id=$1', [id]);
  assert.equal(stage.rows[0].s, 'localisee');

  await open('classification', 'instance', id);
  const cl = await api(base, `/api/projets/${projetId}/postes/classification`, { method: 'POST', token: alice.token, body: { instance_id: id, class_id: chatId } });
  assert.equal(cl.status, 200);
  stage = await (s.pool.query as any)('SELECT instance_stage(x) s FROM instance x WHERE id=$1', [id]);
  assert.equal(stage.rows[0].s, 'classifiee');

  await open('segmentation', 'instance', id);
  const sg = await api(base, `/api/projets/${projetId}/postes/segmentation`, { method: 'POST', token: alice.token, body: { instance_id: id, polygon: [[10, 10], [110, 10], [110, 90], [10, 90]] } });
  assert.equal(sg.status, 200);
  stage = await (s.pool.query as any)('SELECT instance_stage(x) s FROM instance x WHERE id=$1', [id]);
  assert.equal(stage.rows[0].s, 'complete');
});

test('validation instance : refus vers classification efface la classe, garde le polygone', async () => {
  const imgId = await addImage('pipe2');
  await open('localisation', 'image', imgId);
  await api(base, `/api/projets/${projetId}/postes/localisation/terminer`, { method: 'POST', token: alice.token, body: { image_id: imgId, boxes: [{ bbox: { x: 0, y: 0, w: 50, h: 50 } }] } });
  const inst = await (s.pool.query as any)('SELECT id FROM instance WHERE image_id=$1', [imgId]);
  const id = Number(inst.rows[0].id);
  await open('classification', 'instance', id);
  await api(base, `/api/projets/${projetId}/postes/classification`, { method: 'POST', token: alice.token, body: { instance_id: id, class_id: chatId } });
  await open('segmentation', 'instance', id);
  await api(base, `/api/projets/${projetId}/postes/segmentation`, { method: 'POST', token: alice.token, body: { instance_id: id, polygon: [[0, 0], [50, 0], [50, 50]] } });
  await open('validation_instance', 'instance', id);
  const v = await api(base, `/api/projets/${projetId}/postes/validation_instance`, { method: 'POST', token: alice.token, body: { instance_id: id, decision: 'refuser_classification', commentaire: 'mauvaise classe, voir le commentaire' } });
  assert.equal(v.status, 200);
  const row = await (s.pool.query as any)('SELECT class_id, polygon, validee FROM instance WHERE id=$1', [id]);
  assert.equal(row.rows[0].class_id, null, 'classe effacee');
  assert.ok(row.rows[0].polygon, 'polygone conserve');
  assert.equal(row.rows[0].validee, false);
  const ev = await (s.pool.query as any)("SELECT action, details FROM evenement WHERE entite_id=$1 AND action LIKE 'instance_refusee%'", [id]);
  assert.equal(ev.rows[0].details.commentaire, 'mauvaise classe, voir le commentaire', 'commentaire transmis dans l\u2019audit');
});

test('validation instance : refus vers segmentation efface le polygone, garde la classe', async () => {
  const imgId = await addImage('pipe3');
  await open('localisation', 'image', imgId);
  await api(base, `/api/projets/${projetId}/postes/localisation/terminer`, { method: 'POST', token: alice.token, body: { image_id: imgId, boxes: [{ bbox: { x: 0, y: 0, w: 50, h: 50 } }] } });
  const id = Number((await (s.pool.query as any)('SELECT id FROM instance WHERE image_id=$1', [imgId])).rows[0].id);
  await open('classification', 'instance', id);
  await api(base, `/api/projets/${projetId}/postes/classification`, { method: 'POST', token: alice.token, body: { instance_id: id, class_id: chatId } });
  await open('segmentation', 'instance', id);
  await api(base, `/api/projets/${projetId}/postes/segmentation`, { method: 'POST', token: alice.token, body: { instance_id: id, polygon: [[0, 0], [50, 0], [50, 50]] } });
  await open('validation_instance', 'instance', id);
  const v = await api(base, `/api/projets/${projetId}/postes/validation_instance`, { method: 'POST', token: alice.token, body: { instance_id: id, decision: 'refuser_segmentation' } });
  assert.equal(v.status, 200);
  const row = await (s.pool.query as any)('SELECT class_id, polygon FROM instance WHERE id=$1', [id]);
  assert.equal(Number(row.rows[0].class_id), chatId, 'classe conservee');
  assert.equal(row.rows[0].polygon, null, 'polygone efface');
});

test('image negative : poste 1 sans box -> validation image directe', async () => {
  const imgId = await addImage('pipeNEG');
  await open('localisation', 'image', imgId);
  const t = await api(base, `/api/projets/${projetId}/postes/localisation/terminer`, { method: 'POST', token: alice.token, body: { image_id: imgId, boxes: [], negative: true } });
  assert.equal(t.status, 200);
  const img = await (s.pool.query as any)('SELECT negative, localisation_done FROM image WHERE id=$1', [imgId]);
  assert.equal(img.rows[0].negative, true);
  assert.equal(img.rows[0].localisation_done, true);
  // visible en validation image
  const f = await api(base, `/api/projets/${projetId}/postes/validation_image/file`, { token: alice.token });
  assert.ok(f.data.items.some((i: any) => i.id === imgId), 'image negative dans la file validation image');
  await open('validation_image', 'image', imgId);
  const v = await api(base, `/api/projets/${projetId}/postes/validation_image`, { method: 'POST', token: alice.token, body: { image_id: imgId, decision: 'valider' } });
  assert.equal(v.status, 200);
  const img2 = await (s.pool.query as any)('SELECT validee FROM image WHERE id=$1', [imgId]);
  assert.equal(img2.rows[0].validee, true, 'image validee');
});

test('localisation manquante : retour poste 1 en mode AJOUT UNIQUEMENT', async () => {
  const imgId = await addImage('pipeREL');
  await open('localisation', 'image', imgId);
  await api(base, `/api/projets/${projetId}/postes/localisation/terminer`, { method: 'POST', token: alice.token, body: { image_id: imgId, boxes: [{ bbox: { x: 0, y: 0, w: 30, h: 30 } }] } });
  const id = Number((await (s.pool.query as any)('SELECT id FROM instance WHERE image_id=$1', [imgId])).rows[0].id);
  await open('classification', 'instance', id);
  await api(base, `/api/projets/${projetId}/postes/classification`, { method: 'POST', token: alice.token, body: { instance_id: id, class_id: chatId } });
  await open('segmentation', 'instance', id);
  await api(base, `/api/projets/${projetId}/postes/segmentation`, { method: 'POST', token: alice.token, body: { instance_id: id, polygon: [[0, 0], [30, 0], [30, 30]] } });
  await open('validation_instance', 'instance', id);
  await api(base, `/api/projets/${projetId}/postes/validation_instance`, { method: 'POST', token: alice.token, body: { instance_id: id, decision: 'valider' } });
  // passe en validation image
  await open('validation_image', 'image', imgId);
  const v = await api(base, `/api/projets/${projetId}/postes/validation_image`, { method: 'POST', token: alice.token, body: { image_id: imgId, decision: 'localisation_manquante' } });
  assert.equal(v.status, 200);
  const img = await (s.pool.query as any)('SELECT relocalisation_ajout FROM image WHERE id=$1', [imgId]);
  assert.equal(img.rows[0].relocalisation_ajout, true);
  // de retour en poste 1, mode ajout
  await open('localisation', 'image', imgId);
  const add = await api(base, `/api/projets/${projetId}/postes/localisation/ajouter`, { method: 'POST', token: alice.token, body: { image_id: imgId, boxes: [{ bbox: { x: 200, y: 200, w: 40, h: 40 } }] } });
  assert.equal(add.status, 200);
  const insts = await (s.pool.query as any)('SELECT count(*)::int n, count(*) FILTER (WHERE validee)::int v FROM instance WHERE image_id=$1 AND deleted_at IS NULL', [imgId]);
  assert.equal(insts.rows[0].n, 2, 'instance validee conservee + 1 ajoutee');
  assert.equal(insts.rows[0].v, 1, 'l instance validee n a pas ete modifiee');
  const img2 = await (s.pool.query as any)('SELECT relocalisation_ajout FROM image WHERE id=$1', [imgId]);
  assert.equal(img2.rows[0].relocalisation_ajout, false, 'flag leve apres ajout');
});

test('contestation (poste 2) : instance -> corbeille, restaurable', async () => {
  const imgId = await addImage('pipeC');
  await open('localisation', 'image', imgId);
  await api(base, `/api/projets/${projetId}/postes/localisation/terminer`, { method: 'POST', token: alice.token, body: { image_id: imgId, boxes: [{ bbox: { x: 5, y: 5, w: 20, h: 20 } }] } });
  const id = Number((await (s.pool.query as any)('SELECT id FROM instance WHERE image_id=$1', [imgId])).rows[0].id);
  await open('classification', 'instance', id);
  const c = await api(base, `/api/projets/${projetId}/postes/contester`, { method: 'POST', token: alice.token, body: { instance_id: id, poste: 'classification' } });
  assert.equal(c.status, 200);
  const row = await (s.pool.query as any)('SELECT deleted_at FROM instance WHERE id=$1', [id]);
  assert.ok(row.rows[0].deleted_at, 'suppression douce');
  const trash = await api(base, `/api/projets/${projetId}/trash`, { token: admin.token });
  assert.ok(trash.data.corbeille.some((x: any) => Number(x.id) === id));
  const r = await api(base, `/api/projets/${projetId}/trash/${id}/restaurer`, { method: 'POST', token: admin.token });
  assert.equal(r.status, 200);
  const row2 = await (s.pool.query as any)('SELECT deleted_at FROM instance WHERE id=$1', [id]);
  assert.equal(row2.rows[0].deleted_at, null, 'restauree au stade precedent');
});

test('journal d\u2019audit append-only : UPDATE/DELETE/TRUNCATE interdits', async () => {
  await assert.rejects((s.pool.query as any)('UPDATE evenement SET action=$1', ['x']), /append-only/);
  await assert.rejects((s.pool.query as any)('DELETE FROM evenement'), /append-only/);
  await assert.rejects((s.pool.query as any)('TRUNCATE evenement'), /append-only/);
  const n = await (s.pool.query as any)('SELECT count(*)::int c FROM evenement');
  assert.ok(n.rows[0].c > 10, 'audit bien rempli');
});

test('purge corbeille a 7 jours', async () => {
  const imgId = await addImage('pipeT');
  await (s.pool.query as any)("INSERT INTO instance (image_id, bbox, deleted_at) VALUES ($1, $2, now() - interval '8 days')", [imgId, JSON.stringify({ x: 0, y: 0, w: 1, h: 1 })]);
  const { purgeTrash } = await import('../src/server/services/workflow.js');
  const n = (await purgeTrash(7)) ?? 0;
  assert.ok(n >= 1, 'instance de 8 jours purgee');
  const reste = await (s.pool.query as any)("SELECT count(*)::int c FROM instance WHERE image_id=$1 AND deleted_at IS NOT NULL", [imgId]);
  assert.equal(reste.rows[0].c, 0);
});
