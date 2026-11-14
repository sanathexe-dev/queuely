import { useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Timer, Users, CheckCheck, XCircle, Hourglass, Activity, BarChart3, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { useLiveResource } from '../lib/hooks';
import { duration, minutes, pct } from '../lib/format';
import { EmptyState, Spinner } from '../components/ui';

// Categorical slots from the validated reference palette, in fixed order.
const SERIES_1 = '#2a78d6';
const SERIES_2 = '#eb6834';
const GRID = '#e8e6e0';
const AXIS = { fontSize: 12, fill: '#6b6a64' };

const RANGES = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

function tickFor(range, kind) {
  return (t) => {
    const d = new Date(t);
    if (range === '24h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (kind === 'bucket') return d.toLocaleDateString([], range === '7d' ? { weekday: 'short', day: 'numeric' } : { day: 'numeric', month: 'short' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  };
}

function labelFor(range, kind) {
  return (t) => {
    const d = new Date(t);
    if (kind === 'bucket' && range !== '24h') return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
    if (kind === 'bucket') {
      const end = new Date(t + 3600_000);
      const f = (x) => x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `${f(d)} – ${f(end)}`;
    }
    return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
}

function ChartTooltip({ active, payload, label, labelFormatter, valueFormat }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-label">{labelFormatter ? labelFormatter(label) : label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="chart-tip-row">
          <i style={{ background: p.color }} />
          <span>{p.name}</span>
          <b>{valueFormat ? valueFormat(p.value, p) : p.value}</b>
        </div>
      ))}
      {payload[0]?.payload?.cancelled > 0 && (
        <div className="chart-tip-row muted"><i style={{ background: 'transparent' }} /><span>Cancelled</span><b>{payload[0].payload.cancelled}</b></div>
      )}
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, tone }) {
  return (
    <div className={`kpi ${tone || ''}`}>
      <div className="kpi-label"><Icon size={16} /> {label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, subtitle, children, empty }) {
  return (
    <section className="card chart-card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="muted small">{subtitle}</p>}
        </div>
      </div>
      <div className="chart-body">
        {empty ? <div className="chart-empty muted">No data in this period yet</div> : children}
      </div>
    </section>
  );
}

export default function DashboardPage() {
  const [range, setRange] = useState('7d');
  const [queueId, setQueueId] = useState('all');
  const queues = useLiveResource(() => api('/queues'), { interval: 0 });
  const tz = new Date().getTimezoneOffset();
  const { data, loading, error, refresh } = useLiveResource(
    () => api(`/analytics?range=${range}&queueId=${queueId}&tz=${tz}`),
    { interval: 30000, deps: [range, queueId] }
  );

  const waitData = useMemo(
    () => (data?.waitTrend || []).map((b) => ({ ...b, avgWaitMin: minutes(b.avgWaitMs) })),
    [data]
  );
  const busiest = useMemo(() => {
    const hrs = data?.hourly || [];
    const active = hrs.filter((h) => h.arrivals > 0).map((h) => h.hour);
    if (!active.length) return [];
    const lo = Math.min(...active);
    const hi = Math.max(...active);
    return hrs.filter((h) => h.hour >= lo && h.hour <= hi).map((h) => ({
      ...h,
      label: new Date(2000, 0, 1, h.hour).toLocaleTimeString([], { hour: 'numeric' }),
    }));
  }, [data]);
  const peakHour = busiest.length ? busiest.reduce((a, b) => (b.arrivals > a.arrivals ? b : a)) : null;

  const s = data?.summary;
  const noData = s && s.totalTokens === 0 && s.served === 0 && s.waitingNow === 0;
  const xb = tickFor(range, 'bucket');
  const xs = tickFor(range, 'sample');
  const lb = labelFor(range, 'bucket');
  const ls = labelFor(range, 'sample');
  const rangeLabel = RANGES.find((r) => r.id === range).label.toLowerCase();

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Wait times, queue length and throughput over the last {rangeLabel}.</p>
        </div>
        <div className="filters">
          <select value={queueId} onChange={(e) => setQueueId(e.target.value)} aria-label="Queue">
            <option value="all">All queues</option>
            {(queues.data?.queues || []).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
          </select>
          <div className="segmented" role="tablist" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.id} role="tab" aria-selected={range === r.id} className={range === r.id ? 'active' : ''} onClick={() => setRange(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
          <button className="btn icon-only" onClick={refresh} aria-label="Refresh" title="Refresh"><RefreshCw size={16} /></button>
        </div>
      </header>

      {loading && !data ? <Spinner /> : error && !data ? (
        <EmptyState title="Couldn’t load analytics" action={<button className="btn" onClick={refresh}>Try again</button>}>{error.message}</EmptyState>
      ) : noData ? (
        <EmptyState icon={BarChart3} title="Nothing to analyse yet">
          Issue and serve a few tokens and your wait times and trends will show up here.
        </EmptyState>
      ) : (
        <div className={loading ? 'dim' : ''}>
          <div className="kpi-grid">
            <Kpi icon={Timer} label="Average wait" value={duration(s.avgWaitMs, { short: true })}
              sub={s.medianWaitMs !== null ? `median ${duration(s.medianWaitMs, { short: true })} · 90% under ${duration(s.p90WaitMs, { short: true })}` : 'no one called yet'} />
            <Kpi icon={Hourglass} label="Average service" value={duration(s.avgServiceMs, { short: true })} sub={`longest wait ${duration(s.maxWaitMs, { short: true })}`} />
            <Kpi icon={Users} label="Waiting now" value={s.waitingNow}
              sub={s.longestWaitingNowMs ? `oldest has waited ${duration(s.longestWaitingNowMs, { short: true })}` : `peak in period: ${s.peakLength}`} />
            <Kpi icon={CheckCheck} label="Served" value={s.served.toLocaleString()} sub={`${s.totalTokens.toLocaleString()} tokens issued`} />
            <Kpi icon={XCircle} label="Cancellation rate" value={pct(s.cancellationRate)} sub={`${s.cancelled} cancelled or no-show`} />
            <Kpi icon={Activity} label="Busiest hour" value={peakHour ? peakHour.label : '—'} sub={peakHour ? `${peakHour.arrivals} arrivals in total` : 'no arrivals'} />
          </div>

          <div className="chart-grid">
            <ChartCard title="Queue length over time" subtitle="People waiting at each point in time">
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={data.lengthTrend} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="lenFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SERIES_1} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={SERIES_1} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={xs} tick={AXIS} tickLine={false} axisLine={false} minTickGap={36} />
                  <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTooltip labelFormatter={ls} valueFormat={(v) => `${v} waiting`} />} cursor={{ stroke: '#9a988f', strokeDasharray: '3 3' }} />
                  <Area type="stepAfter" dataKey="length" name="Queue length" stroke={SERIES_1} strokeWidth={2} fill="url(#lenFill)" activeDot={{ r: 5, strokeWidth: 2, stroke: '#fff' }} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Average wait time" subtitle={`Minutes from token issued to being called, per ${data.bucket}`} empty={!waitData.some((b) => b.count)}>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={waitData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barCategoryGap="22%">
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="t" tickFormatter={xb} tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} unit="m" />
                  <Tooltip content={<ChartTooltip labelFormatter={lb} valueFormat={(v, p) => (v === null ? '—' : `${v} min (${p.payload.count} called)`)} />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                  <Bar dataKey="avgWaitMin" name="Avg wait" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Arrivals vs served" subtitle={`Tokens issued and completed per ${data.bucket}`} empty={!data.throughput.some((b) => b.arrivals || b.served)}>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data.throughput} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barGap={2} barCategoryGap="22%">
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="t" tickFormatter={xb} tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTooltip labelFormatter={lb} />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                  <Legend iconType="circle" iconSize={9} wrapperStyle={{ fontSize: 13, paddingTop: 6 }} />
                  <Bar dataKey="arrivals" name="Arrivals" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={18} />
                  <Bar dataKey="served" name="Served" fill={SERIES_2} radius={[4, 4, 0, 0]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Busiest hours" subtitle="Arrivals by hour of day" empty={!busiest.length}>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={busiest} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barCategoryGap="18%">
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTooltip valueFormat={(v) => `${v} arrivals`} />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                  <Bar dataKey="arrivals" name="Arrivals" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={32} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {data.perQueue.length > 1 && (
            <section className="card">
              <div className="card-head"><h2>By queue</h2></div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Queue</th><th className="num">Waiting now</th><th className="num">Served</th><th className="num">Cancelled</th><th className="num">Avg wait</th></tr>
                  </thead>
                  <tbody>
                    {data.perQueue.map((q) => (
                      <tr key={q.id}>
                        <td><strong>{q.name}</strong></td>
                        <td className="num">{q.waiting}</td>
                        <td className="num">{q.served.toLocaleString()}</td>
                        <td className="num">{q.cancelled}</td>
                        <td className="num">{duration(q.avgWaitMs, { short: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
