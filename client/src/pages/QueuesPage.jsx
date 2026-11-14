import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Users, Timer, CheckCheck, Inbox, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import { useLiveResource } from '../lib/hooks';
import { duration } from '../lib/format';
import { EmptyState, Modal, Spinner, useToast } from '../components/ui';

export function QueueForm({ initial = { name: '', prefix: '' }, submitLabel, onSubmit, onCancel }) {
  const [name, setName] = useState(initial.name);
  const [prefix, setPrefix] = useState(initial.prefix);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError('Give the queue a name');
    if (prefix && !/^[A-Za-z]{1,3}$/.test(prefix)) return setError('Prefix must be 1–3 letters');
    setBusy(true);
    setError('');
    try {
      await onSubmit({ name: name.trim(), prefix: prefix.trim() || undefined });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <label className="field">
        <span>Queue name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. General Consultation" />
      </label>
      <label className="field">
        <span>Token prefix <em className="muted">(optional, 1–3 letters)</em></span>
        <input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} maxLength={3} placeholder="A" className="mono" />
        <small className="muted">Tokens will look like <span className="mono">{(prefix || 'A').toUpperCase()}-001</span></small>
      </label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
      </div>
    </form>
  );
}

export default function QueuesPage() {
  const { data, loading, error, refresh } = useLiveResource(() => api('/queues'), { interval: 8000 });
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  async function create(values) {
    const { queue } = await api('/queues', { method: 'POST', body: values });
    toast(`Queue “${queue.name}” created`);
    setCreating(false);
    refresh();
    navigate(`/queues/${queue.id}`);
  }

  const queues = data?.queues || [];
  const totalWaiting = queues.reduce((a, q) => a + q.waitingCount, 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Queues</h1>
          <p className="muted">
            {queues.length ? `${queues.length} queue${queues.length > 1 ? 's' : ''} · ${totalWaiting} people waiting right now` : 'Create a queue to start issuing tokens.'}
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={18} /> New queue</button>
      </header>

      {loading && !data ? <Spinner /> : error && !data ? (
        <EmptyState title="Couldn't load queues" action={<button className="btn" onClick={refresh}>Try again</button>}>{error.message}</EmptyState>
      ) : queues.length === 0 ? (
        <EmptyState icon={Inbox} title="No queues yet" action={<button className="btn primary" onClick={() => setCreating(true)}><Plus size={18} /> Create your first queue</button>}>
          A queue is a line of people waiting for one service — like a counter, a desk or a doctor.
        </EmptyState>
      ) : (
        <div className="queue-grid">
          {queues.map((q) => (
            <Link key={q.id} to={`/queues/${q.id}`} className="queue-card">
              <div className="queue-card-top">
                <span className="prefix-badge mono">{q.prefix}</span>
                <h3>{q.name}</h3>
                <ChevronRight size={18} className="chev" />
              </div>
              <div className="queue-card-big">
                <strong>{q.waitingCount}</strong>
                <span>waiting</span>
                {q.servingCount > 0 && <span className="live-pill"><i /> serving</span>}
              </div>
              <div className="queue-card-stats">
                <span><CheckCheck size={15} /> {q.servedToday} served today</span>
                <span><Timer size={15} /> {q.avgWaitMs === null ? 'No waits yet' : `${duration(q.avgWaitMs, { short: true })} avg wait`}</span>
              </div>
            </Link>
          ))}
          <button className="queue-card add" onClick={() => setCreating(true)}>
            <Users size={22} />
            <span>Add another queue</span>
          </button>
        </div>
      )}

      <Modal open={creating} title="New queue" onClose={() => setCreating(false)}>
        <QueueForm submitLabel="Create queue" onSubmit={create} onCancel={() => setCreating(false)} />
      </Modal>
    </div>
  );
}
