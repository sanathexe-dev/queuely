import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Spinner } from './components/ui';
import Layout from './components/Layout';
import AuthPage from './pages/AuthPage';
import QueuesPage from './pages/QueuesPage';
import QueueDetailPage from './pages/QueueDetailPage';
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
import DisplayPage from './pages/DisplayPage';

function RequireAuth({ children }) {
  const { manager, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <div className="center-screen"><Spinner /></div>;
  if (!manager) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

function GuestOnly({ children }) {
  const { manager, ready } = useAuth();
  if (!ready) return <div className="center-screen"><Spinner /></div>;
  if (manager) return <Navigate to="/queues" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><AuthPage mode="login" /></GuestOnly>} />
      <Route path="/register" element={<GuestOnly><AuthPage mode="register" /></GuestOnly>} />
      <Route path="/display/:key" element={<DisplayPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route path="/queues" element={<QueuesPage />} />
        <Route path="/queues/:id" element={<QueueDetailPage />} />
        <Route path="/dashboard" element={<Suspense fallback={<div className="page"><Spinner /></div>}><DashboardPage /></Suspense>} />
      </Route>
      <Route path="*" element={<Navigate to="/queues" replace />} />
    </Routes>
  );
}
