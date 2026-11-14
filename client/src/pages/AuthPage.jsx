import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';
import { useAuth } from '../lib/auth';
import Logo from '../components/Logo';

export default function AuthPage({ mode }) {
  const isLogin = mode === 'login';
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const goNext = () => navigate(location.state?.from || '/queues', { replace: true });

  async function submit(e, creds) {
    e?.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (creds) await login(creds.email, creds.password);
      else if (isLogin) await login(form.email, form.password);
      else await register(form.name, form.email, form.password);
      goNext();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <section className="auth-art" aria-hidden="true">
        <div className="brand light"><Logo /><span>Queuely</span></div>
        <div className="auth-pitch">
          <h1>Calm queues,<br />happier people.</h1>
          <p>Issue tokens, reorder the line, call the next person with one click and see exactly where time goes.</p>
        </div>
        <div className="ticket-stack">
          {[['GC-041', 'Now serving', true], ['GC-042', 'Up next'], ['GC-043', '~6 min']].map(([code, label, live], i) => (
            <div key={code} className={`ticket ${live ? 'live' : ''}`} style={{ '--i': i }}>
              <span className="mono">{code}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit} noValidate>
          <h2>{isLogin ? 'Welcome back' : 'Create your manager account'}</h2>
          <p className="muted">{isLogin ? 'Sign in to manage your queues.' : 'It takes less than a minute.'}</p>

          {!isLogin && (
            <label className="field">
              <span>Full name</span>
              <input value={form.name} onChange={set('name')} autoComplete="name" required maxLength={60} placeholder="Priya Menon" />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input type="email" value={form.email} onChange={set('email')} autoComplete="email" required placeholder="you@company.com" />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={form.password} onChange={set('password')} required minLength={6}
              autoComplete={isLogin ? 'current-password' : 'new-password'} placeholder={isLogin ? '••••••••' : 'At least 6 characters'} />
          </label>

          {error && <div className="form-error" role="alert">{error}</div>}

          <button className="btn primary block lg" disabled={busy}>
            {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'} {!busy && <ArrowRight size={18} />}
          </button>

          {isLogin && (
            <button type="button" className="btn block demo-btn" disabled={busy}
              onClick={() => submit(null, { email: 'demo@queuely.app', password: 'demo1234' })}>
              <Sparkles size={16} /> Explore with the demo account
            </button>
          )}

          <p className="switch">
            {isLogin ? <>New here? <Link to="/register">Create an account</Link></> : <>Already have an account? <Link to="/login">Sign in</Link></>}
          </p>
        </form>
      </section>
    </div>
  );
}
