// WebSocket : tient les compteurs de files a jour en temps reel.
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { config } from './db/pool.js';

const clients = new Map<number, Set<WebSocket>>(); // projetId -> sockets

export function attachWs(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws, req) => {
    let projetId = 0; let userId = 0;
    try {
      const url = new URL(req.url ?? '', 'http://x');
      const token = url.searchParams.get('token') ?? '';
      const payload = jwt.verify(token, config.jwtSecret) as any;
      userId = payload.sub; projetId = Number(url.searchParams.get('projet') || 0);
    } catch { ws.close(4401, 'unauthorized'); return; }
    if (!clients.has(projetId)) clients.set(projetId, new Set());
    clients.get(projetId)!.add(ws);
    ws.on('close', () => { clients.get(projetId)?.delete(ws); });
    ws.on('message', (m) => { if (m.toString() === 'ping') ws.send('pong'); });
  });
  return wss;
}

export function broadcastCounters(projetId: number, poste: string, data: any) {
  const set = clients.get(projetId);
  if (!set) return;
  const msg = JSON.stringify({ type: 'counters', poste, ...data });
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

export function broadcastEvent(projetId: number, event: any) {
  const set = clients.get(projetId);
  if (!set) return;
  const msg = JSON.stringify({ type: 'event', event });
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}
