import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, logout } from '../api/client.js';
import { useAuth, setCachedUser } from '../store/auth.js';

const POSTES = [
  ['localisation', '1 · Localisation'],
  ['classification', '2 · Classification'],
  ['segmentation', '3 · Segmentation'],
  ['validation_instance', '4 · Validation instance'],
  ['validation_image', '5 · Validation image'],
] as const;

export default function Projets() {
  const { user } = useAuth();
  const [projets, setProjets] = useState<any[]>([]);
  const nav = useNavigate();
  useEffect(() => {
    api<{ projets: any[] }>('/projets').then((r) => setProjets(r.projets)).catch(() => {});
  }, []);
  return (
    <div>
      <div className="bar">
        <span className="titre">InstanceSeg Studio</span>
        <span className="spacer" />
        <span style={{ color: 'var(--dim)' }}>{user?.username} ({user?.role})</span>
        {user?.role === 'admin' && <Link to="/admin"><button>Administration</button></Link>}
        <button onClick={async () => { await logout(); setCachedUser(null); nav('/login'); }}>Déconnexion</button>
      </div>
      <div style={{ padding: 20, maxWidth: 900 }}>
        <h2>Mes projets</h2>
        {projets.length === 0 && <p style={{ color: 'var(--dim)' }}>Aucun projet autorisé.</p>}
        {projets.map((p) => (
          <div className="card" key={p.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <b>{p.nom}</b>
              <span className="badge">{p.nb_images} images</span>
              <span className="badge">split {p.pct_train}/{p.pct_val}/{p.pct_test}</span>
              <span className="spacer" />
              <Link to={`/projets/${p.id}/vue`}><button>Vue globale</button></Link>
              {user?.role === 'admin' && <Link to={`/projets/${p.id}/stats`}><button>Stats</button></Link>}
            </div>
            <p style={{ color: 'var(--dim)' }}>{p.description}</p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {POSTES.map(([key, label]) =>
                p.permissions && p.permissions[key] === false
                  ? null
                  : <Link key={key} to={`/projets/${p.id}/poste/${key}`}><button>{label}</button></Link>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
