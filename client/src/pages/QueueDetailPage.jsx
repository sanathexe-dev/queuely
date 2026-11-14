import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, ChevronUp, ChevronDown, ChevronsUp, X, Megaphone, Check, UserPlus, Monitor,
  Pencil, Trash2, Clock, UserX, Users, History, Phone,
} from 'lucide-react';
import { api } from '../lib/api';
import { useLiveResource, useNow } from '../lib/hooks';
import { clock, duration, relative } from '../lib/format';
import { ConfirmDialog, EmptyState, Modal, Spinner, useToast } from '../components/ui';
import { QueueForm } from './QueuesPage';

export default function QueueDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const now = useNow(1000);
  const { data, error, loading, mutate, refresh } = useLiveResource(() => api(`/queues/${id}`), { interval: 5000, deps: [id] });

  const [busy, setBusy] = useState(false);
  const [flashId, setFlashId] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind, token }
  const [renaming, setRenaming] = useState(false);
  const [person, setPerson] = useState({ name: '', phone: '' });
  const [formError, setFormError] = useState('');
  const nameInput = useRef(null);

  useEffect(() => {
    if (!flashId) return undefined;
    const t = setTimeout(() => setFlashId(null), 900);
    return () => clearTimeout(t);
  }, [flashId]);

  const busyRef = useRef(false); // synchronous guard against double clicks before re-render
  async function run(fn, { success, after } = {}) {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await mutate(fn);
      if (success) toast(typeof success === 'function' ? success(res) : success);
      after?.(res);
      return res;
    } catch (err) {
      toast(err.message, 'error');
      if (err.status === 404 || err.status === 409) refresh();
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function addPerson(e) {
    e.preventDefault();
    const name = person.name.trim();
    const phone = person.phone.trim();
    if (!name) {
      setFormError('Enter a name for the token');
      nameInput.current?.focus();
      return;
    }
    if (phone && !/^[+\d][\d\s-]{3,19}$/.test(phone)) {
      setFormError('That phone number doesn’t look right');
      return;
    }
    setFormError('');
    const res = await run(() => api(`/queues/${id}/tokens`, { method: 'POST', body: { name, phone: phone || undefined } }), {
      success: (r) => `Token ${r.token.code} issued to ${r.token.name}`,
    });
    if (res) {
      setPerson({ name: '', phone: '' });
      setFlashId(res.token.id);
      nameInput.current?.focus();
    }
  }

  const move = (token, direction) =>
    run(() => api(`/tokens/${token.id}/move`, { method: 'POST', body: { direction } }), { after: () => setFlashId(token.id) });

  const callNext = () =>
    run(() => api(`/queues/${id}/serve-next`, { method: 'POST' }), { success: (r) => `Now serving ${r.token.code} — ${r.token.name}` });

  const complete = (token) =>
    run(() => api(`/tokens/${token.id}/complete`, { method: 'POST' }), { success: `${token.code} marked as served` });

  async function doConfirm() {
    const { kind, token } = confirm;
    if (kind === 'delete-queue') {
      setBusy(true);
      try {
        await api(`/queues/${id}`, { method: 'DELETE' });
        toast(`Queue “${data.queue.name}” deleted`);
        navigate('/queues');
      } catch (err) {
        toast(err.message, 'error');
        setBusy(false);
      }
      return;
    }
    await run(() => api(`/tokens/${token.id}/cancel`, { method: 'POST' }), {
      success: kind === 'no-show' ? `${token.code} marked as no-show` : `${token.code} cancelled`,
    });
    setConfirm(null);
  }

  async function rename(values) {
    await mutate(() => api(`/queues/${id}`, { method: 'PATCH', body: values }));
    toast('Queue updated');
    setRenaming(false);
  }

  if (loading && !data) return <div className="page"><Spinner /></div>;
  if (error && !data) {
    return (
      <div className="page">
        <EmptyState title={error.status === 404 ? 'Queue not found' : 'Couldn’t load this queue'}
          action={<Link className="btn" to="/queues"><ArrowLeft size={16} /> Back to queues</Link>}>
          {error.status === 404 ? 'It may have been deleted.' : error.message}
        </EmptyState>
      </div>
    );
  }

  const { queue, waiting, serving, recent } = data;
  const current = serving[0];
  const next = waiting[0];
  const avgRecentWait = (() => {
    const w = recent.filter((t) => t.calledAt).map((t) => t.calledAt - t.createdAt);
    return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
  })();

  return (
    <div className="page">
      <Link to="/queues" className="back-link"><ArrowLeft size={16} /> All queues</Link>
      <header className="page-head">
        <div className="title-row">
          <span className="prefix-badge mono lg">{queue.prefix}</span>
          <div>
            <h1>{queue.name}</h1>
            <p className="muted">{waiting.length} waiting · {serving.length ? `serving ${current.code}` : 'counter free'}</p>
          </div>
        </div>
        <div className="head-actions">
          <a className="btn" href={`${import.meta.env.BASE_URL}display/${queue.displayKey}`} target="_blank" rel="noreferrer"><Monitor size={16} /> Display screen</a>
          <button className="btn icon-only" onClick={() => setRenaming(true)} aria-label="Edit queue" title="Edit queue"><Pencil size={16} /></button>
          <button className="btn icon-only danger-ghost" onClick={() => setConfirm({ kind: 'delete-queue' })} aria-label="Delete queue" title="Delete queue"><Trash2 size={16} /></button>
        </div>
      </header>

      <div className="detail-grid">
        <div className="col-main">
          {/* ---------- Counter ---------- */}
          <section className={`counter ${current ? 'busy' : ''}`}>
            <div className="counter-now">
              <span className="eyebrow">{current ? 'Now serving' : 'Counter'}</span>
              {current ? (
                <>
                  <div className="counter-code mono">{current.code}</div>
                  <div className="counter-name">{current.name}</div>
                  <div className="counter-meta">
                    <Clock size={14} /> Serving for {duration(now - current.calledAt)} · waited {duration(current.calledAt - current.createdAt, { short: true })}
                  </div>
                  <div className="counter-actions">
                    <button className="btn on-dark" onClick={() => complete(current)} disabled={busy}><Check size={16} /> Mark served</button>
                    <button className="btn on-dark ghost" onClick={() => setConfirm({ kind: 'no-show', token: current })} disabled={busy}><UserX size={16} /> No-show</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="counter-code idle">— — —</div>
                  <div className="counter-name">Ready for the next person</div>
                </>
              )}
            </div>
            <button className="call-next" onClick={callNext} disabled={busy || !next}>
              <Megaphone size={26} />
              <span className="call-label">{current ? 'Finish & call next' : 'Call next'}</span>
              <span className="call-sub">{next ? <><b className="mono">{next.code}</b> {next.name}</> : 'No one waiting'}</span>
            </button>
          </section>

          {/* ---------- Add person ---------- */}
          <form className="add-person card" onSubmit={addPerson} noValidate>
            <div className="add-fields">
              <label className="field inline grow">
                <span className="sr-only">Name</span>
                <UserPlus size={18} className="field-icon" />
                <input ref={nameInput} value={person.name} maxLength={60} placeholder="Add a person — name"
                  onChange={(e) => { setPerson((p) => ({ ...p, name: e.target.value })); setFormError(''); }} />
              </label>
              <label className="field inline phone">
                <span className="sr-only">Phone (optional)</span>
                <Phone size={16} className="field-icon" />
                <input value={person.phone} maxLength={20} placeholder="Phone (optional)" inputMode="tel"
                  onChange={(e) => { setPerson((p) => ({ ...p, phone: e.target.value })); setFormError(''); }} />
              </label>
              <button className="btn primary" disabled={busy}>Issue token</button>
            </div>
            {formError && <div className="form-error slim" role="alert">{formError}</div>}
          </form>

          {/* ---------- Waiting list ---------- */}
          <section className="card list-card">
            <div className="card-head">
              <h2><Users size={18} /> Waiting <span className="count">{waiting.length}</span></h2>
              {waiting.length > 0 && <span className="muted small">Next token: <b className="mono">{queue.prefix}-{String(queue.nextNumber).padStart(3, '0')}</b></span>}
            </div>
            {waiting.length === 0 ? (
              <EmptyState icon={Users} title="Nobody is waiting">Add a person above to issue their token.</EmptyState>
            ) : (
              <ol className="token-list">
                {waiting.map((t, i) => (
                  <li key={t.id} className={`token-row ${i === 0 ? 'is-next' : ''} ${flashId === t.id ? 'flash' : ''}`}>
                    <span className="pos">{i + 1}</span>
                    <span className="code mono">{t.code}</span>
                    <span className="who">
                      <strong>{t.name}</strong>
                      <small className="muted">{t.phone ? `${t.phone} · ` : ''}joined {clock(t.createdAt)}</small>
                    </span>
                    {i === 0 && <span className="next-tag">Next</span>}
                    <span className={`waited ${now - t.createdAt > 20 * 60000 ? 'warn' : ''}`} title="Time waiting">
                      <Clock size={13} /> {duration(now - t.createdAt, { short: true })}
                    </span>
                    <span className="row-actions">
                      <button className="icon-btn" title="Move to top" aria-label={`Move ${t.code} to top`} disabled={busy || i === 0} onClick={() => move(t, 'top')}><ChevronsUp size={16} /></button>
                      <button className="icon-btn" title="Move up" aria-label={`Move ${t.code} up`} disabled={busy || i === 0} onClick={() => move(t, 'up')}><ChevronUp size={16} /></button>
                      <button className="icon-btn" title="Move down" aria-label={`Move ${t.code} down`} disabled={busy || i === waiting.length - 1} onClick={() => move(t, 'down')}><ChevronDown size={16} /></button>
                      <button className="icon-btn danger" title="Cancel token" aria-label={`Cancel ${t.code}`} disabled={busy} onClick={() => setConfirm({ kind: 'cancel', token: t })}><X size={16} /></button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        {/* ---------- Side ---------- */}
        <aside className="col-side">
          <div className="mini-stats">
            <div><span>Waiting</span><strong>{waiting.length}</strong></div>
            <div><span>Longest wait</span><strong>{waiting.length ? duration(now - Math.min(...waiting.map((t) => t.createdAt)), { short: true }) : '—'}</strong></div>
            <div><span>Recent avg wait</span><strong>{duration(avgRecentWait, { short: true })}</strong></div>
          </div>
          <section className="card">
            <div className="card-head"><h2><History size={18} /> Recent activity</h2></div>
            {recent.length === 0 ? (
              <p className="muted small pad">Served and cancelled tokens will appear here.</p>
            ) : (
              <ul className="activity">
                {recent.map((t) => (
                  <li key={t.id}>
                    <span className={`dot ${t.status}`} />
                    <span className="mono code-sm">{t.code}</span>
                    <span className="act-name">{t.name}</span>
                    <span className="act-meta">
                      <span className={`status-tag ${t.status}`}>{t.status === 'served' ? 'Served' : t.calledAt ? 'No-show' : 'Cancelled'}</span>
                      <small className="muted">{relative(t.completedAt || t.cancelledAt, now)}</small>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={!!confirm}
        busy={busy}
        danger
        title={confirm?.kind === 'delete-queue' ? 'Delete this queue?' : confirm?.kind === 'no-show' ? 'Mark as no-show?' : 'Cancel this token?'}
        message={
          confirm?.kind === 'delete-queue'
            ? `“${queue.name}” and all of its tokens and history will be permanently deleted.`
            : confirm
              ? `${confirm.token.code} (${confirm.token.name}) will be removed from the queue.`
              : ''
        }
        confirmLabel={confirm?.kind === 'delete-queue' ? 'Delete queue' : confirm?.kind === 'no-show' ? 'Mark no-show' : 'Cancel token'}
        onConfirm={doConfirm}
        onClose={() => !busy && setConfirm(null)}
      />

      <Modal open={renaming} title="Edit queue" onClose={() => setRenaming(false)}>
        <QueueForm initial={{ name: queue.name, prefix: queue.prefix }} submitLabel="Save changes" onSubmit={rename} onCancel={() => setRenaming(false)} />
      </Modal>
    </div>
  );
}
