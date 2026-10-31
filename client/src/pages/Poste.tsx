import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, connectWs } from '../api/client.js';
import type { BBox, Point, Poste as PosteT } from '../../../src/shared/types.js';
import { POSTE_LABEL } from '../../../src/shared/types.js';

// Écran de poste identique partout : barre gauche (file), canvas central,
// panneau droit spécifique au poste. Flèches ← →, Ctrl+Z / Ctrl+Y (10
// modifications, la pile traverse les items), WS pour les compteurs.
export default function Poste() {
  const { id, poste } = useParams<{ id: string; poste: PosteT }>();
  const nav = useNavigate();
  const [file, setFile] = useState<any[]>([]);
  const [compteurs, setCompteurs] = useState<any>(null);
  const [idx, setIdx] = useState(0);
  const [item, setItem] = useState<any>(null);       // détail image ou instance
  const [classes, setClasses] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [modeValidation, setModeValidation] = useState<'instance' | 'image'>('instance');
  const [commentaire, setCommentaire] = useState('');
  const [undoStack, setUndoStack] = useState<any[]>([]);
  const [redoStack, setRedoStack] = useState<any[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [view, setView] = useState({ scale: 1, ox: 0, oy: 0 });
  const [draw, setDraw] = useState<any>({ boxes: [] as BBox[], polygon: [] as Point[], mode: 'box' as 'box' | 'poly' });
  const dragRef = useRef<any>(null);
  const projId = Number(id);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2500); };

  const loadFile = useCallback(async () => {
    const r = await api<any>(`/projets/${projId}/postes/${poste}/file`);
    setFile(r.items); setCompteurs(r.compteurs);
    return r.items as any[];
  }, [projId, poste]);

  const openItem = useCallback(async (it: any, i: number) => {
    setIdx(i); setErr('');
    try {
      await api(`/projets/${projId}/postes/${poste}/ouvrir`, { method: 'POST', body: JSON.stringify({ kind: it.kind, item_id: it.id }) });
    } catch (e: any) {
      if (e.code === 'LOCKED') { flash(`Item verrouillé par ${e.locked_by}`); await loadFile(); return; }
      setErr(e.message);
    }
    const det = await api<any>(`/projets/${projId}/postes/${poste}/item/${it.kind}/${it.id}`);
    setItem(det);
    setDraw({ boxes: [], polygon: [], mode: poste === 'localisation' ? 'box' : 'poly' });
    if (poste === 'localisation') {
      const insts = await api<any>(`/projets/${projId}/images/${it.image_id}`);
      setDraw((d: any) => ({ ...d, boxes: insts.instances.filter((x: any) => !x.validee || true).map((x: any) => x.bbox).filter(Boolean) }));
    }
  }, [projId, poste, loadFile]);

  useEffect(() => {
    api<{ classes: any[] }>(`/projets/${projId}/classes`).then((r) => setClasses(r.classes)).catch(() => {});
    loadFile().then((items) => { if (items[0]) openItem(items[0], 0); });
    const ws = connectWs(projId, (m) => {
      if (m.type === 'counters' && m.poste === poste) setCompteurs({ disponibles: m.disponibles, verrouilles: m.verrouilles });
    });
    return () => ws.close();
  }, [projId, poste]);

  // Dessin canvas
  useEffect(() => {
    const cv = canvasRef.current; if (!cv || !item) return;
    const isImg = !!item.image && (poste === 'localisation' || (poste === 'validation_image'));
    const src = isImg ? `/uploads/${item.image.chemin}` : (item.instance?.crop_chemin ? `/uploads/${item.instance.crop_chemin}` : `/uploads/${item.image.chemin}`);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const maxW = cv.parentElement!.clientWidth - 8, maxH = cv.parentElement!.clientHeight - 8;
      const scale = Math.min(1, maxW / img.width, maxH / img.height);
      cv.width = img.width * scale; cv.height = img.height * scale;
      setView({ scale, ox: 0, oy: 0 });
      redraw();
    };
    img.src = src;
  }, [item, poste]);

  function redraw() {
    const cv = canvasRef.current, img = imgRef.current; if (!cv || !img) return;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const s = view.scale;
    const toPx = (x: number, y: number) => [x * s, y * s];
    // instances existantes (localisation / validation image)
    if (item.instances) {
      for (const inst of item.instances) {
        if (!inst.bbox) continue;
        const [x, y] = toPx(inst.bbox.x, inst.bbox.y);
        ctx.strokeStyle = inst.validee ? '#22c55e' : (inst.couleur || '#3b82f6');
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, inst.bbox.w * s, inst.bbox.h * s);
        if (inst.polygon) {
          ctx.beginPath();
          inst.polygon.forEach(([px, py]: [number, number], i: number) => { const [cx, cy] = toPx(px, py); i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
          ctx.closePath(); ctx.stroke();
        }
      }
    }
    // tracé en cours
    ctx.strokeStyle = '#f59e0b'; ctx.fillStyle = '#f59e0b'; ctx.lineWidth = 2;
    for (const b of draw.boxes) {
      const [x, y] = toPx(b.x, b.y);
      ctx.strokeRect(x, y, b.w * s, b.h * s);
    }
    if (draw.polygon.length) {
      ctx.beginPath();
      draw.polygon.forEach((pt: Point, i: number) => { const [cx, cy] = toPx(pt[0], pt[1]); i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
      if (draw.mode === 'poly') ctx.closePath();
      ctx.stroke();
      for (const [px, py] of draw.polygon) { const [cx, cy] = toPx(px, py); ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 7); ctx.fill(); }
    }
  }
  useEffect(redraw, [draw, view, item]);

  function canvasPos(e: React.MouseEvent) {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / view.scale, y: (e.clientY - r.top) / view.scale };
  }

  function onDown(e: React.MouseEvent) {
    const p = canvasPos(e);
    if (poste === 'localisation' && draw.mode === 'box') {
      dragRef.current = { x0: p.x, y0: p.y, box: { x: p.x, y: p.y, w: 0, h: 0 } };
    } else if (poste === 'segmentation' && draw.mode === 'poly') {
      setDraw((d: any) => ({ ...d, polygon: [...d.polygon, [Math.round(p.x), Math.round(p.y)] as Point] }));
    }
  }
  function onMove(e: React.MouseEvent) {
    if (!dragRef.current) return;
    const p = canvasPos(e);
    const b = dragRef.current;
    b.box = { x: Math.min(b.x0, p.x), y: Math.min(b.y0, p.y), w: Math.abs(p.x - b.x0), h: Math.abs(p.y - b.y0) };
    setDraw((d: any) => ({ ...d, boxes: [...d.boxes.filter((x: any) => x !== b.box), b.box] }));
  }
  function onUp() {
    if (dragRef.current) {
      const b = dragRef.current.box;
      if (b.w > 5 && b.h > 5) pushUndo({ boxes: draw.boxes.filter((x: any) => x !== b), add: b });
      dragRef.current = null;
    }
  }

  function pushUndo(action: any) {
    setUndoStack((s) => [...s.slice(-9), action]); // 10 niveaux max
    setRedoStack([]);
  }
  const undo = useCallback(() => {
    setUndoStack((s) => {
      if (!s.length) return s;
      const last = s[s.length - 1];
      setRedoStack((r) => [...r, last]);
      if (last.add) setDraw((d: any) => ({ ...d, boxes: d.boxes.filter((x: any) => x !== last.add) }));
      if (last.remove) setDraw((d: any) => ({ ...d, boxes: [...d.boxes, ...last.remove] }));
      if (last.polygon) setDraw((d: any) => ({ ...d, polygon: last.polygon }));
      return s.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setRedoStack((r) => {
      if (!r.length) return r;
      const last = r[r.length - 1];
      setUndoStack((s) => [...s, last]);
      if (last.add) setDraw((d: any) => ({ ...d, boxes: [...d.boxes, last.add] }));
      if (last.remove) setDraw((d: any) => ({ ...d, boxes: d.boxes.filter((x: any) => !last.remove.includes(x)) }));
      return r.slice(0, -1);
    });
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      if (e.key === 'ArrowLeft') navPrev();
      if (e.key === 'ArrowRight') navNext();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [file, idx, undo, redo]);

  function navNext() { if (idx < file.length - 1) openItem(file[idx + 1], idx + 1); }
  function navPrev() { if (idx > 0) openItem(file[idx - 1], idx - 1); }

  async function apresValidation() {
    const items = await loadFile();
    const next = items.find((x: any) => x.id !== item?.instance?.id && x.id !== item?.image?.id) ?? items[0];
    if (next) openItem(next, items.indexOf(next)); else setItem(null);
  }

  async function terminer() {
    setErr('');
    try {
      if (poste === 'localisation') {
        const img = item.image;
        if (img.relocalisation_ajout) {
          await api(`/projets/${projId}/postes/localisation/ajouter`, { method: 'POST', body: JSON.stringify({ image_id: img.id, boxes: draw.boxes.map((b: BBox) => ({ bbox: b })) }) });
        } else {
          await api(`/projets/${projId}/postes/localisation/terminer`, { method: 'POST', body: JSON.stringify({ image_id: img.id, boxes: draw.boxes.map((b: BBox) => ({ bbox: b })), negative: draw.boxes.length === 0 }) });
        }
        flash(draw.boxes.length === 0 && !img.relocalisation_ajout ? 'Image marquée négative → validation d’image' : 'Localisée');
      }
      await apresValidation();
    } catch (e: any) { setErr(e.message); }
  }

  const cur = file[idx];
  const isImagePoste = poste === 'localisation' || poste === 'validation_image';

  return (
    <div>
      <div className="bar">
        <Link to="/"><button>←</button></Link>
        <span className="titre">{POSTE_LABEL[poste!]}</span>
        <span className="compteur">disponibles: {compteurs?.disponibles ?? '…'} · verrouillés: {compteurs?.verrouilles ?? '…'} · ma file: {file.length}</span>
        <span className="spacer" />
        <button onClick={navPrev} disabled={idx <= 0}>← Précédent</button>
        <button onClick={navNext} disabled={idx >= file.length - 1}>Suivant →</button>
        <span className="kbd">Ctrl+Z</span><span className="kbd">Ctrl+Y</span>
      </div>
      <div className="layout">
        <div className="gauche">
          {file.map((it, i) => (
            <div key={`${it.kind}${it.id}`} className={'item' + (i === idx ? ' actif' : '')} onClick={() => openItem(it, i)}>
              <span>#{it.id} {it.kind === 'instance' ? 'instance' : 'image'}</span>
              <span className="stade">{it.instance?.stage ?? (it.negative ? 'négative' : '')}</span>
            </div>
          ))}
          {file.length === 0 && <div style={{ padding: 12, color: 'var(--dim)' }}>File vide.</div>}
        </div>
        <div className="centre">
          <canvas ref={canvasRef} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}
            onDoubleClick={() => { if (poste === 'segmentation' && draw.polygon.length >= 3) setDraw((d: any) => ({ ...d, mode: 'poly' })) }} />
        </div>
        <div className="droite panneau">
          {err && <div className="err">{err}</div>}
          {poste === 'localisation' && item?.image && (
            <>
              <h3>Localisation — image #{item.image.id}</h3>
              {item.image.relocalisation_ajout
                ? <div className="card" style={{ borderColor: 'var(--warn)' }}>Mode <b>AJOUT UNIQUEMENT</b> (localisation manquante) : instances validées conservées, ni modification ni suppression.</div>
                : <div className="card">Tracez les bounding boxes. « Terminer » sans aucune box → image <b>négative</b>.</div>}
              <div className="card">{draw.boxes.length} box(es) tracée(s)<br />
                <button onClick={() => { pushUndo({ remove: draw.boxes }); setDraw((d: any) => ({ ...d, boxes: [] })); }}>Tout effacer</button>
              </div>
              <button className="primary" style={{ width: '100%' }} onClick={terminer}>Terminer</button>
            </>
          )}
          {poste === 'classification' && item?.instance && (
            <>
              <h3>Classification — instance #{item.instance.id} (crop uniquement)</h3>
              <div className="card classes">
                {classes.map((c) => (
                  <button key={c.id} style={{ borderLeftColor: c.couleur }} onClick={async () => {
                    try {
                      await api(`/projets/${projId}/postes/classification`, { method: 'POST', body: JSON.stringify({ instance_id: item.instance.id, class_id: c.id }) });
                      flash(`Classée : ${c.nom}`);
                      await apresValidation();
                    } catch (e: any) { setErr(e.message); }
                  }}>{c.nom}</button>
                ))}
              </div>
              <div className="card"><button className="danger" style={{ width: '100%' }} onClick={async () => {
                try { await api(`/projets/${projId}/postes/contester`, { method: 'POST', body: JSON.stringify({ instance_id: item.instance.id, poste: 'classification' }) }); flash('Contestation → corbeille'); await apresValidation(); }
                catch (e: any) { setErr(e.message); }
              }}>Contester la localisation</button></div>
            </>
          )}
          {poste === 'segmentation' && item?.instance && (
            <>
              <h3>Segmentation — instance #{item.instance.id} (crop)</h3>
              <div className="card">Mode « nouveau polygone » : cliquez pour ajouter des points, double-clic pour fermer.<br />
                <button onClick={() => { pushUndo({ polygon: draw.polygon }); setDraw((d: any) => ({ ...d, polygon: [] })); }}>Recommencer</button>
              </div>
              <div className="card">{draw.polygon.length} point(s)</div>
              <button className="primary" style={{ width: '100%', marginBottom: 6 }} onClick={async () => {
                try {
                  await api(`/projets/${projId}/postes/segmentation`, { method: 'POST', body: JSON.stringify({ instance_id: item.instance.id, polygon: draw.polygon }) });
                  flash('Segmentée'); await apresValidation();
                } catch (e: any) { setErr(e.message); }
              }}>Valider le polygone</button>
              <button className="danger" style={{ width: '100%' }} onClick={async () => {
                try { await api(`/projets/${projId}/postes/contester`, { method: 'POST', body: JSON.stringify({ instance_id: item.instance.id, poste: 'segmentation' }) }); flash('Contestation → corbeille'); await apresValidation(); }
                catch (e: any) { setErr(e.message); }
              }}>Contester la localisation</button>
            </>
          )}
          {poste === 'validation_instance' && item?.instance && (
            <>
              <h3>Validation d'instance #{item.instance.id}</h3>
              <div className="card">
                <label><input type="radio" checked={modeValidation === 'instance'} onChange={() => setModeValidation('instance')} /> instance</label>{' '}
                <label><input type="radio" checked={modeValidation === 'image'} onChange={() => setModeValidation('image')} /> image</label>
              </div>
              {modeValidation === 'instance' && <>
                <div className="card">
                  <textarea placeholder="commentaire optionnel (transmis à l'annotateur qui reprend)" value={commentaire} onChange={(e) => setCommentaire(e.target.value)} style={{ width: '100%', minHeight: 60 }} />
                </div>
                <button className="ok" style={{ width: '100%', marginBottom: 6 }} onClick={async () => {
                  try { await api(`/projets/${projId}/postes/validation_instance`, { method: 'POST', body: JSON.stringify({ instance_id: item.instance.id, decision: 'valider', commentaire }) }); flash('Validée'); await apresValidation(); }
                  catch (e: any) { setErr(e.message); }
                }}>Valider</button>
                <button className="danger" style={{ width: '100%', marginBottom: 6 }} onClick={async () => {
                  try { await api(`/projets/${projId}/postes/validation_instance`, { method: 'POST', body: JSON.stringify({ instance_id: item.instance.id, decision: 'refuser_classification', commentaire }) }); flash('Refus → classification (classe effacée, polygone conservé)'); await apresValidation(); }
                  catch (e: any) { setErr(e.message); }
                }}>Refuser → classification</button>
                <button className="danger" style={{ width: '100%' }} onClick={async () => {
                  try { await api(`/projets/${projId}/postes/validation_instance`, { method: 'POST', body: JSON.stringify({ instance_id: item.instance.id, decision: 'refuser_segmentation', commentaire }) }); flash('Refus → segmentation (polygone effacé, classe conservée)'); await apresValidation(); }
                  catch (e: any) { setErr(e.message); }
                }}>Refuser → segmentation</button>
              </>}
            </>
          )}
          {poste === 'validation_image' && item?.image && (
            <>
              <h3>Validation d'image #{item.image.id}</h3>
              <div className="card">{item.image.negative ? 'Image négative (aucune instance).' : `${item.instances?.filter((i: any) => i.validee).length ?? 0}/${item.instances?.length ?? 0} instances validées`}</div>
              <button className="ok" style={{ width: '100%', marginBottom: 6 }} onClick={async () => {
                try { await api(`/projets/${projId}/postes/validation_image`, { method: 'POST', body: JSON.stringify({ image_id: item.image.id, decision: 'valider' }) }); flash('Image validée'); await apresValidation(); }
                catch (e: any) { setErr(e.message); }
              }}>Valider l'image</button>
              <button className="danger" style={{ width: '100%' }} onClick={async () => {
                try { await api(`/projets/${projId}/postes/validation_image`, { method: 'POST', body: JSON.stringify({ image_id: item.image.id, decision: 'localisation_manquante' }) }); flash('→ poste 1 en mode AJOUT UNIQUEMENT'); await apresValidation(); }
                catch (e: any) { setErr(e.message); }
              }}>Localisation manquante</button>
            </>
          )}
        </div>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
