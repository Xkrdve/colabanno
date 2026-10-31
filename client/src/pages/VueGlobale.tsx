import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';

// Vue globale du projet : toutes les images par stade, filtres (stade,
// classes présentes), marques favoris privées.
export default function VueGlobale() {
  const { id } = useParams<{ id: string }>();
  const [images, setImages] = useState<any[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [f, setF] = useState({ split: '', classe: '', validee: '', marque: false });
  const [audit, setAudit] = useState<any[] | null>(null);
  const [auditImage, setAuditImage] = useState<number | null>(null);

  useEffect(() => {
    api<{ classes: any[] }>(`/projets/${id}/classes`).then((r) => setClasses(r.classes));
  }, [id]);

  useEffect(() => {
    const q = new URLSearchParams();
    if (f.split) q.set('split', f.split);
    if (f.classe) q.set('classe', f.classe);
    if (f.validee) q.set('validee', f.validee);
    if (f.marque) q.set('marque', 'true');
    api<{ images: any[] }>(`/projets/${id}/images?${q}`).then((r) => setImages(r.images));
  }, [id, f]);

  async function toggleMarque(im: any) {
    await api(`/projets/${id}/images/${im.id}/marque`, { method: im.marquee ? 'DELETE' : 'POST' });
    setF({ ...f });
  }
  async function voirAudit(im: any) {
    setAuditImage(im.id);
    const r = await api<{ evenements: any[] }>(`/projets/${id}/images/${im.id}/audit`);
    setAudit(r.evenements);
  }

  return (
    <div>
      <div className="bar">
        <Link to="/"><button>←</button></Link>
        <span className="titre">Vue globale — projet #{id}</span>
      </div>
      <div className="filtres">
        <select value={f.split} onChange={(e) => setF({ ...f, split: e.target.value })}>
          <option value="">tous splits</option><option value="train">train</option><option value="val">val</option><option value="test">test</option>
        </select>
        <select value={f.classe} onChange={(e) => setF({ ...f, classe: e.target.value })}>
          <option value="">toutes classes</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
        </select>
        <select value={f.validee} onChange={(e) => setF({ ...f, validee: e.target.value })}>
          <option value="">tous stades</option><option value="true">validées</option><option value="false">en cours</option>
        </select>
        <label><input type="checkbox" checked={f.marque} onChange={(e) => setF({ ...f, marque: e.target.checked })} /> ★ mes marques</label>
      </div>
      <div className="grid">
        {images.length === 0 && <p style={{ color: 'var(--dim)' }}>Aucune image.</p>}
        {images.map((im) => (
          <div className="thumb" key={im.id}>
            <img src={im.thumb_chemin ? `/uploads/${im.thumb_chemin}` : `/uploads/${im.chemin}`} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
            <div className="meta">
              <span className={'badge' + (im.validee ? ' validee' : '') + (im.negative ? ' negative' : '')}>
                {im.validee ? 'validée' : im.negative ? 'négative' : `${im.nb_validees}/${im.nb_instances} inst.`}
              </span>
              <span className="badge">{im.split}</span>
              <div>
                <button onClick={() => toggleMarque(im)}>{im.marquee ? '★' : '☆'}</button>
                <button onClick={() => voirAudit(im)}>audit</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {audit && (
        <div className="toast" style={{ maxWidth: 480, maxHeight: 320, overflow: 'auto' }}>
          <b>Audit image #{auditImage}</b> <button onClick={() => setAudit(null)} style={{ float: 'right' }}>✕</button>
          {audit.map((e) => <div key={e.id} style={{ fontSize: 11 }}>{new Date(e.created_at).toLocaleString()} — <b>{e.username}</b> {e.action} {e.entite}#{e.entite_id}</div>)}
        </div>
      )}
    </div>
  );
}
