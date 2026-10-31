import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';

// Statistiques admin : instances/classe, images validées, stades, rythme par
// poste et par annotateur — filtres classe, annotateur, jour, stade.
export default function Stats() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [f, setF] = useState({ classe: '', annotateur: '', jour: '' });
  const [classes, setClasses] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  useEffect(() => {
    api<{ classes: any[] }>(`/projets/${id}/classes`).then((r) => setClasses(r.classes));
    api<{ users: any[] }>('/auth/users').then((r) => setUsers(r.users));
  }, [id]);
  useEffect(() => {
    const q = new URLSearchParams();
    if (f.classe) q.set('classe', f.classe);
    if (f.annotateur) q.set('annotateur', f.annotateur);
    if (f.jour) q.set('jour', f.jour);
    api<any>(`/projets/${id}/stats?${q}`).then(setData).catch(() => {});
  }, [id, f]);

  if (!data) return <div><div className="bar"><Link to="/"><button>←</button></Link><span className="titre">Statistiques — chargement…</span></div></div>;
  return (
    <div>
      <div className="bar">
        <Link to="/"><button>←</button></Link>
        <span className="titre">Statistiques — projet #{id} (calculées à la volée)</span>
      </div>
      <div className="filtres">
        <select value={f.classe} onChange={(e) => setF({ ...f, classe: e.target.value })}>
          <option value="">toutes classes</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
        </select>
        <select value={f.annotateur} onChange={(e) => setF({ ...f, annotateur: e.target.value })}>
          <option value="">tous annotateurs</option>{users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
        </select>
        <input type="date" value={f.jour} onChange={(e) => setF({ ...f, jour: e.target.value })} />
      </div>
      <div style={{ display: 'flex', gap: 14, padding: 16, flexWrap: 'wrap' }}>
        <Card title="Images" data={data?.images} render={(d: any) => (
          <table><tbody>
            <tr><td>total</td><td>{d?.total}</td></tr><tr><td>validées</td><td>{d?.validees}</td></tr>
            <tr><td>négatives</td><td>{d?.negatives}</td></tr><tr><td>à localiser</td><td>{d?.a_localiser}</td></tr>
            <tr><td>relocalisation</td><td>{d?.relocalisation}</td></tr>
          </tbody></table>
        )} />
        <Card title="Instances par classe" data={data?.par_classe} render={(rows: any[]) => (
          <table><thead><tr><th>classe</th><th>n</th></tr></thead><tbody>
            {rows?.map((r: any) => <tr key={r.class_id}><td>{r.nom}</td><td>{r.n}</td></tr>)}
          </tbody></table>
        )} />
        <Card title="Instances par stade" data={data?.par_stage} render={(rows: any[]) => (
          <table><thead><tr><th>stade</th><th>n</th></tr></thead><tbody>
            {rows?.map((r: any) => <tr key={r.stage}><td>{r.stage}</td><td>{r.n}</td></tr>)}
          </tbody></table>
        )} />
        <Card title="Rythme par poste" data={data?.rythme_par_poste} render={(rows: any[]) => (
          <table><thead><tr><th>poste</th><th>actions</th></tr></thead><tbody>
            {rows?.map((r: any) => <tr key={r.poste}><td>{r.poste}</td><td>{r.n}</td></tr>)}
          </tbody></table>
        )} />
        <Card title="Rythme par annotateur" data={data?.rythme_par_annotateur} render={(rows: any[]) => (
          <table><thead><tr><th>annotateur</th><th>actions</th></tr></thead><tbody>
            {rows?.map((r: any) => <tr key={r.user_id}><td>{r.username}</td><td>{r.n}</td></tr>)}
          </tbody></table>
        )} />
      </div>
    </div>
  );
}
function Card({ title, data, render }: { title: string; data: any; render: (d: any) => React.ReactNode }) {
  return <div className="card" style={{ minWidth: 240 }}><h3>{title}</h3>{render(data)}</div>;
}
