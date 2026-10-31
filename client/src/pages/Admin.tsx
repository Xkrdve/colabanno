import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

// Paramétrage global : comptes (admin seul), projets, membres, classes z-index,
// import d'images, corbeille, exports.
export default function Admin() {
  const [onglet, setOnglet] = useState<'comptes' | 'projets' | 'classes' | 'import' | 'corbeille' | 'exports'>('comptes');
  const [projets, setProjets] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [projetId, setProjetId] = useState<number | ''>('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api<{ projets: any[] }>('/projets').then((r) => { setProjets(r.projets); if (!projetId && r.projets[0]) setProjetId(r.projets[0].id); });
    api<{ users: any[] }>('/auth/users').then((r) => setUsers(r.users));
  }, []);
  useEffect(() => {
    if (projetId) api<{ classes: any[] }>(`/projets/${projetId}/classes`).then((r) => setClasses(r.classes)).catch(() => {});
  }, [projetId]);

  return (
    <div>
      <div className="bar">
        <Link to="/"><button>← Projets</button></Link>
        <span className="titre">Administration</span>
        <span className="spacer" />
        <div className="onglets">
          {(['comptes', 'projets', 'classes', 'import', 'corbeille', 'exports'] as const).map((o) => (
            <button key={o} className={onglet === o ? 'actif' : ''} onClick={() => setOnglet(o)}>{o}</button>
          ))}
        </div>
      </div>
      {msg && <div className="toast">{msg}</div>}
      <div style={{ padding: 16, maxWidth: 980 }}>
        {onglet === 'comptes' && <Comptes users={users} onChange={() => api<{ users: any[] }>('/auth/users').then((r) => setUsers(r.users))} setMsg={setMsg} />}
        {onglet === 'projets' && <ProjetsAdmin projets={projets} onChange={() => api<{ projets: any[] }>('/projets').then((r) => setProjets(r.projets))} setMsg={setMsg} />}
        {onglet === 'classes' && projetId && <ClassesAdmin projetId={projetId} projets={projets} setProjetId={setProjetId} classes={classes} setClasses={setClasses} setMsg={setMsg} />}
        {onglet === 'import' && projetId && <ImportAdmin projetId={projetId} projets={projets} setProjetId={setProjetId} setMsg={setMsg} />}
        {onglet === 'corbeille' && projetId && <Corbeille projetId={projetId} />}
        {onglet === 'exports' && projetId && <ExportsAdmin projetId={projetId} />}
      </div>
    </div>
  );
}

function Comptes({ users, onChange, setMsg }: any) {
  const [form, setForm] = useState({ email: '', username: '', password: '', role: 'annotateur' });
  return (
    <div>
      <h3>Créer un compte (admin uniquement — pas d'auto-inscription)</h3>
      <div className="card" style={{ display: 'flex', gap: 8 }}>
        <input placeholder="e-mail" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input placeholder="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <input type="password" placeholder="mot de passe" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="annotateur">annotateur</option><option value="admin">admin</option>
        </select>
        <button className="primary" onClick={async () => {
          try {
            await api('/auth/users', { method: 'POST', body: JSON.stringify(form) });
            setMsg('Compte créé'); onChange(); setForm({ email: '', username: '', password: '', role: 'annotateur' });
          } catch (e: any) { setMsg(e.message); }
        }}>Créer</button>
      </div>
      <table><thead><tr><th>id</th><th>username</th><th>e-mail</th><th>rôle</th></tr></thead>
        <tbody>{users.map((u: any) => <tr key={u.id}><td>{u.id}</td><td>{u.username}</td><td>{u.email}</td><td>{u.role}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function ProjetsAdmin({ projets, onChange, setMsg }: any) {
  const [form, setForm] = useState({ nom: '', description: '', pct_train: 80, pct_val: 10, pct_test: 10 });
  const [membres, setMembres] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [sel, setSel] = useState<number | ''>('');
  useEffect(() => { api<{ users: any[] }>('/auth/users').then((r) => setUsers(r.users)); }, []);
  useEffect(() => { if (sel) api<{ membres: any[] }>(`/projets/${sel}/membres`).then((r) => setMembres(r.membres)); }, [sel]);
  return (
    <div>
      <h3>Créer un projet</h3>
      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input placeholder="nom" value={form.nom} onChange={(e) => setForm({ ...form, nom: e.target.value })} />
        <input placeholder="description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ flex: 1 }} />
        <input type="number" title="% train" value={form.pct_train} onChange={(e) => setForm({ ...form, pct_train: +e.target.value })} style={{ width: 70 }} />
        <input type="number" title="% val" value={form.pct_val} onChange={(e) => setForm({ ...form, pct_val: +e.target.value })} style={{ width: 70 }} />
        <input type="number" title="% test" value={form.pct_test} onChange={(e) => setForm({ ...form, pct_test: +e.target.value })} style={{ width: 70 }} />
        <button className="primary" onClick={async () => {
          try { await api('/projets', { method: 'POST', body: JSON.stringify(form) }); setMsg('Projet créé'); onChange(); }
          catch (e: any) { setMsg(e.message); }
        }}>Créer</button>
      </div>
      <h3>Projets</h3>
      <table><thead><tr><th>id</th><th>nom</th><th>split</th><th>images</th><th></th></tr></thead>
        <tbody>{projets.map((p: any) => (
          <tr key={p.id}><td>{p.id}</td><td>{p.nom}</td><td>{p.pct_train}/{p.pct_val}/{p.pct_test}</td><td>{p.nb_images}</td>
            <td><button onClick={() => setSel(p.id)}>Membres</button></td></tr>))}</tbody>
      </table>
      {sel && <div className="card">
        <h3>Autoriser un annotateur — projet #{sel}</h3>
        <select value="" onChange={async (e) => {
          const uid = +e.target.value; if (!uid) return;
          try {
            await api(`/projets/${sel}/membres`, { method: 'POST', body: JSON.stringify({ user_id: uid, permissions: { localisation: true, classification: true, segmentation: true, validation_instance: true, validation_image: true } }) });
            setMsg('Membre ajouté'); api<{ membres: any[] }>(`/projets/${sel}/membres`).then((r) => setMembres(r.membres));
          } catch (err: any) { setMsg(err.message); }
        }}><option value="">+ ajouter…</option>{users.map((u: any) => <option key={u.id} value={u.id}>{u.username}</option>)}</select>
        <table><thead><tr><th>utilisateur</th><th>permissions par poste</th><th></th></tr></thead>
          <tbody>{membres.map((m: any) => (
            <tr key={m.user_id}><td>{m.username}</td>
              <td style={{ fontSize: 11 }}>{Object.entries(m.permissions).filter(([, v]) => v).map(([k]) => k).join(', ')}</td>
              <td><button className="danger" onClick={async () => { await api(`/projets/${sel}/membres/${m.user_id}`, { method: 'DELETE' }); api<{ membres: any[] }>(`/projets/${sel}/membres`).then((r) => setMembres(r.membres)); }}>Retirer</button></td>
            </tr>))}</tbody>
        </table>
      </div>}
    </div>
  );
}

function ClassesAdmin({ projetId, projets, setProjetId, classes, setClasses, setMsg }: any) {
  const [nom, setNom] = useState('');
  const [couleur, setCouleur] = useState('#3b82f6');
  const [dragId, setDragId] = useState<number | null>(null);
  async function reload() { const r = await api<{ classes: any[] }>(`/projets/${projetId}/classes`); setClasses(r.classes); }
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        Projet : <select value={projetId} onChange={(e) => setProjetId(+e.target.value)}>
          {projets.map((p: any) => <option key={p.id} value={p.id}>{p.nom}</option>)}
        </select>
      </div>
      <div className="card" style={{ display: 'flex', gap: 8 }}>
        <input placeholder="nouvelle classe" value={nom} onChange={(e) => setNom(e.target.value)} />
        <input type="color" value={couleur} onChange={(e) => setCouleur(e.target.value)} style={{ width: 44 }} />
        <button className="primary" onClick={async () => {
          try { await api(`/projets/${projetId}/classes`, { method: 'POST', body: JSON.stringify({ nom, couleur }) }); setNom(''); reload(); }
          catch (e: any) { setMsg(e.message); }
        }}>Ajouter</button>
      </div>
      <p style={{ color: 'var(--dim)', fontSize: 11 }}>Glissez-déposez pour définir le z-index (résout les chevauchements en export sémantique).</p>
      <div>
        {classes.map((c: any) => (
          <div key={c.id} draggable
            onDragStart={() => setDragId(c.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              e.preventDefault();
              if (dragId == null || dragId === c.id) return;
              const ordre = classes.map((x: any) => x.id);
              const from = ordre.indexOf(dragId), to = ordre.indexOf(c.id);
              ordre.splice(to, 0, ...ordre.splice(from, 1));
              await api(`/projets/${projetId}/classes/ordre`, { method: 'PUT', body: JSON.stringify({ ordre }) });
              reload();
            }}
            className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'grab' }}>
            <span style={{ width: 14, height: 14, background: c.couleur, borderRadius: 3, display: 'inline-block' }} />
            <b>{c.nom}</b><span className="badge">z-index {c.z_index}</span>
            <span className="spacer" />
            <button className="danger" onClick={async () => {
              const r = await fetch(`/api/projets/${projetId}/classes/${c.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ onDelete: 'reclassifier' }) });
              const d = await r.json();
              setMsg(d.warning ? `Warning : ${d.warning}` : 'Classe supprimée');
              reload();
            }}>Supprimer</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ImportAdmin({ projetId, projets, setProjetId, setMsg }: any) {
  const [files, setFiles] = useState<FileList | null>(null);
  const [res, setRes] = useState<any>(null);
  return (
    <div>
      <div style={{ marginBottom: 10 }}>Projet : <select value={projetId} onChange={(e) => setProjetId(+e.target.value)}>
        {projets.map((p: any) => <option key={p.id} value={p.id}>{p.nom}</option>)}</select></div>
      <div className="card">
        <input type="file" accept="image/png,image/jpeg" multiple onChange={(e) => setFiles(e.target.files)} />
        <button className="primary" style={{ marginLeft: 8 }} onClick={async () => {
          if (!files?.length) return;
          const fd = new FormData();
          for (const f of Array.from(files)) fd.append('fichiers', f);
          const r = await fetch(`/api/projets/${projetId}/images/import`, { method: 'POST', body: fd, credentials: 'same-origin' });
          const d = await r.json();
          setRes(d); setMsg(`Import : ${d.importes} importée(s), ${d.doublons} doublon(s) ignoré(s)`);
        }}>Importer (PNG/JPG, anti-doublons SHA-256)</button>
      </div>
      {res && <div className="card" style={{ fontSize: 12 }}>
        {res.details?.map((d: any, i: number) => <div key={i}>{d.status === 'erreur' ? `❌ ${d.nom}: ${d.error}` : `${d.status === 'doublon' ? '⏭️' : '✅'} ${d.nom ?? d.sha256?.slice(0, 12)} — ${d.split ?? ''}`}</div>)}
      </div>}
    </div>
  );
}

function Corbeille({ projetId }: any) {
  const [items, setItems] = useState<any[]>([]);
  async function reload() { const r = await api<{ corbeille: any[] }>(`/projets/${projetId}/trash`); setItems(r.corbeille); }
  useEffect(() => { reload(); }, [projetId]);
  return (
    <div>
      <h3>Corbeille (purge automatique à 7 jours)</h3>
      <button onClick={async () => { const r = await api<any>(`/projets/${projetId}/trash/purge`, { method: 'POST' }); alert(`${r.purgees} supprimée(s)`); reload(); }}>Purger maintenant</button>
      <table><thead><tr><th>instance</th><th>image</th><th>stade avant</th><th>supprimée le</th><th></th></tr></thead>
        <tbody>{items.map((x: any) => (
          <tr key={x.id}><td>#{x.id}</td><td>#{x.image_id}</td><td>{x.stage_avant}</td><td>{new Date(x.deleted_at).toLocaleString()}</td>
            <td><button className="ok" onClick={async () => { await api(`/projets/${projetId}/trash/${x.id}/restaurer`, { method: 'POST' }); reload(); }}>Restaurer</button></td></tr>))}
        </tbody></table>
    </div>
  );
}

function ExportsAdmin({ projetId }: any) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [format, setFormat] = useState('coco');
  const [filtres, setFiltres] = useState('{}');
  async function reload() { const r = await api<{ jobs: any[] }>(`/projets/${projetId}/exports`); setJobs(r.jobs); }
  useEffect(() => { reload(); const t = setInterval(reload, 2000); return () => clearInterval(t); }, [projetId]);
  return (
    <div>
      <h3>Export manuel à la demande</h3>
      <div className="card" style={{ display: 'flex', gap: 8 }}>
        <select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="coco">COCO</option><option value="yolo-seg">YOLO-seg</option><option value="semantique">Segmentation sémantique</option>
        </select>
        <input style={{ flex: 1 }} placeholder='filtres JSON ex {"splits":["train"],"classIds":[1]}' value={filtres} onChange={(e) => setFiltres(e.target.value)} />
        <button className="primary" onClick={async () => {
          let f = {}; try { f = JSON.parse(filtres || '{}'); } catch { alert('JSON invalide'); return; }
          await api(`/projets/${projetId}/exports`, { method: 'POST', body: JSON.stringify({ format, filters: f }) });
          reload();
        }}>Lancer l'export</button>
      </div>
      <div className="card" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <b>Export automatique périodique</b>
        <button onClick={async () => { await api(`/projets/${projetId}/exports/auto`, { method: 'POST', body: JSON.stringify({ enabled: true, intervalMin: 60 }) }); }}>Activer (60 min)</button>
        <button className="danger" onClick={async () => { await api(`/projets/${projetId}/exports/auto`, { method: 'POST', body: JSON.stringify({ enabled: false }) }); }}>Désactiver</button>
      </div>
      <table><thead><tr><th>job</th><th>format</th><th>statut</th><th>résultat</th></tr></thead>
        <tbody>{jobs.map((j: any) => (
          <tr key={j.id}><td>#{j.id}</td><td>{j.payload?.format}</td><td>{j.statut}</td>
            <td style={{ fontSize: 11 }}>{j.statut === 'done' ? JSON.stringify(j.resultat) : j.erreur ?? ''}</td></tr>))}
        </tbody></table>
    </div>
  );
}
