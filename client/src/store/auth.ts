import { useEffect, useState } from 'react';
import { me } from '../api/client.js';

let cached: any = null;
const listeners = new Set<() => void>();

export function useAuth() {
  const [state, setState] = useState<{ user: any; loading: boolean }>({ user: cached, loading: !cached });
  useEffect(() => {
    const fn = () => setState({ user: cached, loading: false });
    listeners.add(fn);
    if (!cached) me().then((r) => { cached = r.user; [...listeners].forEach((l) => l()); })
      .catch(() => setState({ user: null, loading: false }));
    return () => { listeners.delete(fn); };
  }, []);
  return state;
}
export function setCachedUser(u: any) { cached = u; [...listeners].forEach((l) => l()); }
