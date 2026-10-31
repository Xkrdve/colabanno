// Lance un PostgreSQL embarque dans le processus courant (tests, e2e) et
// retourne la DATABASE_URL. Jamais de binding reseau autre que loopback.
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';

export interface EmbeddedDb {
  url: string;
  stop: () => Promise<void>;
}

let counter = 0;

export async function startEmbeddedPg(dir?: string): Promise<EmbeddedDb> {
  const d = dir || path.resolve(`.pgdata-test-${process.pid}-${counter++}`);
  fs.rmSync(d, { recursive: true, force: true });
  const port = 55500 + (process.pid % 500) + counter;
  const pg = new EmbeddedPostgres({
    databaseDir: d,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: true,
    initdbFlags: ['--encoding=UTF-8', '--locale=C', '--auth=trust'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('instanceseg').catch(() => {});
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/instanceseg`,
    stop: async () => { await pg.stop(); fs.rmSync(d, { recursive: true, force: true }); },
  };
}
