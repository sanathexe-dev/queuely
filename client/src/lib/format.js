export function duration(ms, { short = false } = {}) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return short ? `${m}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export const minutes = (ms) => (ms === null || ms === undefined ? null : +(ms / 60000).toFixed(1));

export function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function relative(ts, now = Date.now()) {
  const d = now - ts;
  if (d < 45_000) return 'just now';
  if (d < 3600_000) return `${Math.round(d / 60000)} min ago`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)} h ago`;
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
