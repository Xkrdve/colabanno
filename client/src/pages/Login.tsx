import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../api/client.js';
import { setCachedUser } from '../store/auth.js';

export default function Login() {
  const [identifiant, setIdentifiant] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const nav = useNavigate();
  return (
    <div className="login">
      <h1>InstanceSeg Studio</h1>
      <p style={{ color: 'var(--dim)' }}>Annotation collaborative — segmentation d'instances</p>
      <div className="card">
        <input placeholder="E-mail ou username" value={identifiant} onChange={(e) => setIdentifiant(e.target.value)} />
        <input type="password" placeholder="Mot de passe" value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        {err && <div className="err">{err}</div>}
        <button className="primary" style={{ width: '100%' }} onClick={submit}>Connexion</button>
      </div>
      <p style={{ color: 'var(--dim)', fontSize: 11 }}>Pas d'auto-inscription : les comptes sont créés par l'admin.</p>
    </div>
  );
  async function submit() {
    try {
      const r = await login(identifiant, password);
      setCachedUser(r.user);
      nav('/');
    } catch (e: any) { setErr(e.message); }
  }
}
