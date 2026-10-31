// Demarre (ou reutilise) un PostgreSQL embarque local pour le dev sans Docker.
// Boucle 127.0.0.1 uniquement. Usage: npm run dev:db
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.env.EMBEDDED_PG_DIR || './.pgdata');
const port = Number(process.env.EMBEDDED_PG_PORT || 55432);
const user = 'postgres';
const password = 'postgres';

const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user, password, port,
  persistent: true,
  initdbFlags: ['--encoding=UTF-8', '--locale=C', '--auth=trust'],
});

if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) {
  console.log('[dev-db] initialisation du cluster embarque...');
  await pg.initialise();
}
console.log(`[dev-db] demarrage PostgreSQL embarque sur 127.0.0.1:${port}`);
await pg.start();
await pg.createDatabase('instanceseg').catch(() => {});
console.log(`[dev-db] pret. DATABASE_URL=postgres://${user}:${password}@127.0.0.1:${port}/instanceseg`);
console.log('[dev-db] Ctrl+C pour arreter.');

process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
