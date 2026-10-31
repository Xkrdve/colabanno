// Lance Postgres embarque (si EMBEDDED_PG=1) + API + Vite en parallele.
import { spawn } from 'node:child_process';

const procs = [];
function run(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  p.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  return p;
}

if (process.env.EMBEDDED_PG !== '0') {
  run('db', 'npx', ['tsx', 'scripts/dev-db.ts']);
  await new Promise((r) => setTimeout(r, 8000)); // laisse le cluster demarrer
  process.env.DATABASE_URL = process.env.DATABASE_URL
    || `postgres://postgres:postgres@127.0.0.1:${process.env.EMBEDDED_PG_PORT || 55432}/instanceseg`;
}
run('api', 'npx', ['tsx', 'src/server/index.ts']);
run('web', 'npx', ['vite', 'client']);

process.on('SIGINT', () => { procs.forEach((p) => p.kill('SIGINT')); process.exit(0); });
