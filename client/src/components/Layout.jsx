import { NavLink, Outlet } from 'react-router-dom';
import { LayoutList, BarChart3, LogOut } from 'lucide-react';
import { useAuth } from '../lib/auth';
import Logo from './Logo';

export default function Layout() {
  const { manager, logout } = useAuth();
  const initials = manager.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><Logo /><span>Queuely</span></div>
        <nav>
          <NavLink to="/queues" className="nav-link"><LayoutList size={18} /> <span>Queues</span></NavLink>
          <NavLink to="/dashboard" className="nav-link"><BarChart3 size={18} /> <span>Dashboard</span></NavLink>
        </nav>
        <div className="sidebar-foot">
          <div className="me">
            <div className="avatar">{initials}</div>
            <div className="me-text">
              <strong>{manager.name}</strong>
              <span>{manager.email}</span>
            </div>
          </div>
          <button className="icon-btn ghost" onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={18} /></button>
        </div>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  );
}
