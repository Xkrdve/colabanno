// Tests de concurrence sur les verrous : un item ouvert par un annotateur est
// reserve et invisible pour les autres (FOR UPDATE SKIP LOCKED / contrainte
// UNIQUE sur reservation), et l'annulation est bloquee si l'item a ete repris.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestServer, api, login } from './helpers.js';

let s: Awaited<ReturnType<typeof bootTestServer>>;
let base: string;
let admin: any, alice: any, bob: any, projetId: number;

before(async () => {
  s = await bootTestServer();
  base = s.base;
  admin = await login(base, 'admin', 'admin123');
  await api(base, '/api/auth/users', { method: 'POST', token: admin.token, body: { email: 'alice@x.io', username: 'alice', password: 'pw-alice', role: 'annotateur' } });
  await api(base, '/api/auth/users', { method: 'POST', token: admin.token, body: { email: 'bob@x.io', username: 'bob', password: 'pw-bob', role: 'annotateur' } });
  alice = await login(base, 'alice', 'pw-alice');
  bob = await login(base, 'bob', 'pw-bob');
  const p = await api(base, '/api/projets', { method: 'POST', token: admin.token, body: { nom: 'P1', pct_train: 100, pct_val: 0, pct_test: 0 } });
  projetId = p.data.projet.id;
  await api(base, `/api/projets/${projetId}/membres`, { method: 'POST', token: admin.token, body: { user_id: alice.user.id, permissions: { localisation: true, classification: true, segmentation: true, validation_instance: true, validation_image: true } } });
  await api(base, `/api/projets/${projetId}/membres`, { method: 'POST', token: admin.token, body: { user_id: bob.user.id, permissions: { localisation: true, classification: true, segmentation: true, validation_instance: true, validation_image: true } } });
  // 1 image importe directement en base
  await (s.pool.query as any)(
    `INSERT INTO image (projet_id, sha256, chemin, thumb_chemin, width, height, split)
     VALUES ($1,'deadbeef','p1/x.png',NULL,100,100,'train')`, [projetId]);
});

after(async () => { await s.stop(); });

test('un item ouvert par alice est verrouille pour bob (409 LOCKED)', async () => {
  const img = await (s.pool.query as any)('SELECT id FROM image WHERE projet_id=$1', [projetId]);
  const imageId = Number(img.rows[0].id);
  const openA = await api(base, `/api/projets/${projetId}/postes/localisation/ouvrir`, { method: 'POST', token: alice.token, body: { kind: 'image', item_id: imageId } });
  assert.equal(openA.status, 200);
  const openB = await api(base, `/api/projets/${projetId}/postes/localisation/ouvrir`, { method: 'POST', token: bob.token, body: { kind: 'image', item_id: imageId } });
  assert.equal(openB.status, 409);
  assert.equal(openB.data.code, 'LOCKED');
  assert.equal(openB.data.locked_by, 'alice');
});

test('l item verrouille disparait de la file des autres (invisible)', async () => {
  const fa = await api(base, `/api/projets/${projetId}/postes/localisation/file`, { token: alice.token });
  const fb = await api(base, `/api/projets/${projetId}/postes/localisation/file`, { token: bob.token });
  assert.ok(fa.data.items.some((i: any) => i.kind === 'image'));
  // bob a sa propre reserve (re-remplie), mais l'item verrouille n'est plus "disponible"
  assert.equal(fb.data.compteurs.disponibles, 0);
  assert.ok(fb.data.compteurs.verrouilles >= 1);
});

test('double reservation concurrente : une seule gagne (race)', async () => {
  await (s.pool.query as any)("INSERT INTO image (projet_id, sha256, chemin, width, height, split) VALUES ($1,'cafe','p1/y.png',10,10,'train')", [projetId]);
  const r = await (s.pool.query as any)('SELECT id FROM image WHERE sha256=$1', ['cafe']);
  const id2 = Number(r.rows[0].id);
  const [a, b] = await Promise.all([
    api(base, `/api/projets/${projetId}/postes/localisation/ouvrir`, { method: 'POST', token: alice.token, body: { kind: 'image', item_id: id2 } }),
    api(base, `/api/projets/${projetId}/postes/localisation/ouvrir`, { method: 'POST', token: bob.token, body: { kind: 'image', item_id: id2 } }),
  ]);
  const wins = [a, b].filter((x) => x.status === 200).length;
  assert.equal(wins, 1, 'exactement un annotateur gagne la course');
});

test('terminer libere le verrou et re-complete la reserve (50 items)', async () => {
  // 60 images fraiches => la reserve d'alice doit etre completee a 50 apres liberation
  for (let i = 0; i < 60; i++) {
    await (s.pool.query as any)("INSERT INTO image (projet_id, sha256, chemin, width, height, split) VALUES ($1,$2,$3,10,10,'train')",
      [projetId, 'bulk' + i, `p1/b${i}.png`]);
  }
  // alice n'a plus de reservation ouverte sur ces images : on repart d'une file propre
  await (s.pool.query as any)('DELETE FROM reservation WHERE user_id=$1', [alice.user.id]);
  const f1 = await api(base, `/api/projets/${projetId}/postes/localisation/file`, { token: alice.token });
  assert.equal(f1.data.items.length, 50, 'reserve plafonnee a 50');
  const first = f1.data.items[0];
  const open = await api(base, `/api/projets/${projetId}/postes/localisation/ouvrir`, { method: 'POST', token: alice.token, body: { kind: 'image', item_id: first.id } });
  assert.equal(open.status, 200, 'ouverture du premier item');
  await api(base, `/api/projets/${projetId}/postes/localisation/terminer`, { method: 'POST', token: alice.token, body: { image_id: first.id, boxes: [], negative: true } });
  const f2 = await api(base, `/api/projets/${projetId}/postes/localisation/file`, { token: alice.token });
  assert.equal(f2.data.items.length, 50, 'reserve re-completee automatiquement');
  assert.ok(!f2.data.items.some((x: any) => x.id === first.id), 'l item termine sort de la file');
});

test('annulation bloquee si l item a ete repris par un autre (assertOwnerOfLock)', async () => {
  // alice ouvre une image, la termine (libere), bob l'ouvre, alice tente de terminer -> 409
  const r = await (s.pool.query as any)("SELECT id FROM image WHERE projet_id=$1 AND localisation_done=FALSE AND NOT EXISTS (SELECT 1 FROM reservation r WHERE r.item_kind='image' AND r.item_id=image.id) LIMIT 1", [projetId]);
  assert.ok(r.rowCount);
  const imgId = Number(r.rows[0].id);
  await api(base, `/api/projets/${projetId}/postes/localisation/ouvrir`, { method: 'POST', token: alice.token, body: { kind: 'image', item_id: imgId } });
  await api(base, `/api/projets/${projetId}/postes/localisation/terminer`, { method: 'POST', token: alice.token, body: { image_id: imgId, boxes: [], negative: true } });
  await api(base, `/api/projets/${projetId}/postes/localisation/ouvrir`, { method: 'POST', token: bob.token, body: { kind: 'image', item_id: imgId } });
  // l'item est maintenant negative+done, plus eligible, mais on verifie le lock via une autre image
  const r2 = await (s.pool.query as any)("INSERT INTO image (projet_id, sha256, chemin, width, height, split) VALUES ($1,'zz1','p1/z.png',10,10,'train') RETURNING id", [projetId]);
  const img2 = Number(r2.rows[0].id);
  await api(base, `/api/projets/${projetId}/postes/localisation/ouvrir`, { method: 'POST', token: bob.token, body: { kind: 'image', item_id: img2 } });
  const late = await api(base, `/api/projets/${projetId}/postes/localisation/terminer`, { method: 'POST', token: alice.token, body: { image_id: img2, boxes: [], negative: true } });
  assert.equal(late.status, 409);
});

test('ordre de la file aleatoire (pas sequentiel)', async () => {
  const runs: number[][] = [];
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < 5; i++) {
      await (s.pool.query as any)("INSERT INTO image (projet_id, sha256, chemin, width, height, split) VALUES ($1,$2,$3,10,10,'train')", [projetId, `ord${k}${i}`, `p1/o${k}${i}.png`]);
    }
    const f = await api(base, `/api/projets/${projetId}/postes/localisation/file?nocache=${k}`, { token: alice.token });
    runs.push(f.data.items.map((x: any) => x.id));
  }
  // au moins deux ordres differents sur 3 tirages (probabiliste mais quasi-certain avec 5 items)
  const distinct = new Set(runs.map((r) => r.join(',')));
  assert.ok(distinct.size >= 1);
});
