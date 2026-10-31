import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { config, migrate, pool } from './db/pool.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import imageRoutes from './routes/images.js';
import posteRoutes from './routes/postes.js';
import { attachWs } from './ws.js';
import { errHandler } from './mw/auth.js';
import { purgeTrash } from './services/workflow.js';

export async function createServer() {
  await migrate();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/projets', projectRoutes);
  app.use('/api/projets', imageRoutes);
  app.use('/api/projets', posteRoutes);

  // Fichiers uploades (images, miniatures, crops)
  app.use('/uploads', express.static(config.uploadDir));

  // SPA buildée (si presente)
  const distClient = path.resolve('dist/client');
  if (fs.existsSync(distClient)) {
    app.use(express.static(distClient));
    app.get(/^\/(?!api|uploads|ws).*/, (_req, res) =>
      res.sendFile(path.join(distClient, 'index.html')));
  }

  app.use(errHandler);

  const server = http.createServer(app);
  attachWs(server);

  // Purge automatique de la corbeille (toutes les heures)
  const purgeTimer = setInterval(() => purgeTrash().catch(() => {}), 3_600_000);
  purgeTimer.unref?.();

  return { app, server };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('index.ts');
if (isMain) {
  const { server } = await createServer();
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`[server] API REST + WS sur http://127.0.0.1:${config.port} (ws: /ws)`);
  });
}

export { pool };
