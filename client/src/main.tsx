import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login.js';
import Projets from './pages/Projets.js';
import Admin from './pages/Admin.js';
import Poste from './pages/Poste.js';
import VueGlobale from './pages/VueGlobale.js';
import Stats from './pages/Stats.js';
import { useAuth } from './store/auth.js';

function Guard({ children }: { children: React.ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ padding: 40 }}>Chargement…</div>;
  if (!user) return <Navigate to="/login" />;
  return children;
}
function AdminGuard({ children }: { children: React.ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ padding: 40 }}>Chargement…</div>;
  if (!user) return <Navigate to="/login" />;
  if (user.role !== 'admin') return <Navigate to="/" />;
  return children;
}

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Guard><Projets /></Guard>} />
      <Route path="/admin" element={<AdminGuard><Admin /></AdminGuard>} />
      <Route path="/projets/:id/vue" element={<Guard><VueGlobale /></Guard>} />
      <Route path="/projets/:id/stats" element={<AdminGuard><Stats /></AdminGuard>} />
      <Route path="/projets/:id/poste/:poste" element={<Guard><Poste /></Guard>} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  </BrowserRouter>
);
