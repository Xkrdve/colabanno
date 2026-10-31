// Client API REST + WebSocket.
export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin',
    ...opts,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), data);
  return data as T;
}

export function connectWs(projetId: number, onMessage: (msg: any) => void): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getCookie('token') || '';
  const ws = new WebSocket(`${proto}://${location.host}/ws?projet=${projetId}&token=${encodeURIComponent(token)}`);
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
  return ws;
}

function getCookie(name: string): string {
  return document.cookie.split('; ').find((r) => r.startsWith(name + '='))?.split('=')[1] ?? '';
}

export async function login(identifiant: string, password: string) {
  return api<{ user: any }>('/auth/login', { method: 'POST', body: JSON.stringify({ identifiant, password }) });
}
export async function logout() { return api('/auth/logout', { method: 'POST' }); }
export async function me() { return api<{ user: any }>('/auth/me'); }
