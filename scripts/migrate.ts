import 'dotenv/config';
import { migrate, pool } from '../src/server/db/pool.js';

await migrate();
console.log('Migrations appliquees.');
await pool.end();
