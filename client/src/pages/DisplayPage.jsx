import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useLiveResource, useNow } from '../lib/hooks';
import Logo from '../components/Logo';

/** Public, read-only board for a TV / second screen. Shows first names only. */
export default function DisplayPage() {
  const { key } = useParams();
  const now = useNow(1000);
  const { data, error } = useLiveResource(() => api(`/display/${encodeURIComponent(key)}`, { auth: false }), { interval: 4000, deps: [key] });
  const current = data?.serving?.[0];
  const lastCode = useRef(null);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (!current) return undefined;
    if (lastCode.current && lastCode.current !== current.code) setPulse(true);
    lastCode.current = current.code;
    const t = setTimeout(() => setPulse(false), 2400);
    return () => clearTimeout(t);
  }, [current]);

  useEffect(() => {
    if (data?.name) document.title = `${data.name} · Now serving`;
  }, [data?.name]);

  if (error && !data) {
    return <div className="display"><div className="display-error">This display link is not valid.</div></div>;
  }

  return (
    <div className="display">
      <header className="display-head">
        <div className="brand light"><Logo /><span>{data?.name || 'Loading…'}</span></div>
        <div className="display-clock mono">{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </header>
      <main className="display-body">
        <section className={`display-now ${pulse ? 'pulse' : ''}`}>
          <span className="eyebrow">Now serving</span>
          <div className="display-code mono">{current ? current.code : '—'}</div>
          <div className="display-name">{current ? current.name : 'Please wait to be called'}</div>
        </section>
        <section className="display-next">
          <span className="eyebrow">Up next</span>
          {data?.next?.length ? (
            <ol>
              {data.next.map((t, i) => (
                <li key={t.code}><span className="n">{i + 1}</span><span className="mono">{t.code}</span><span>{t.name}</span></li>
              ))}
            </ol>
          ) : <p className="display-empty">No one waiting</p>}
          {data && data.waitingCount > data.next.length && <p className="display-more">+{data.waitingCount - data.next.length} more waiting</p>}
        </section>
      </main>
    </div>
  );
}
