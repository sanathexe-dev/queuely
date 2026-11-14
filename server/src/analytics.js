const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const RANGES = {
  '24h': { span: DAY, bucket: HOUR, sample: 15 * MIN },
  '7d': { span: 7 * DAY, bucket: DAY, sample: HOUR },
  '30d': { span: 30 * DAY, bucket: DAY, sample: 4 * HOUR },
};

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x) => (x === null ? null : Math.round(x));

function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/**
 * tzOffset is the client's Date#getTimezoneOffset() (minutes, UTC - local),
 * so local = utc - tzOffset. Buckets are aligned to the manager's local hours/days.
 */
function computeAnalytics(db, { queues, range, tzOffset, now }) {
  const cfg = RANGES[range];
  const shift = -tzOffset * MIN; // utc -> local
  const alignDown = (t, size) => Math.floor((t + shift) / size) * size - shift;

  // e.g. 7d => the last 7 local calendar days including today; 24h => the last 24 clock hours.
  const from = alignDown(now - cfg.span, cfg.bucket) + cfg.bucket;
  const ids = queues.map((x) => x.id);

  const empty = {
    range,
    from,
    to: now,
    summary: {
      totalTokens: 0, served: 0, cancelled: 0, waitingNow: 0, servingNow: 0,
      avgWaitMs: null, medianWaitMs: null, p90WaitMs: null, maxWaitMs: null,
      avgServiceMs: null, cancellationRate: null, longestWaitingNowMs: null, peakLength: 0,
    },
    waitTrend: [],
    lengthTrend: [],
    throughput: [],
    hourly: Array.from({ length: 24 }, (_, h) => ({ hour: h, arrivals: 0 })),
    perQueue: [],
  };
  if (!ids.length) return empty;

  const ph = ids.map(() => '?').join(',');
  // Every token that was alive at some point in the window, plus anything still open.
  const tokens = db
    .prepare(
      `SELECT id, queue_id, status, created_at, called_at, completed_at, cancelled_at
       FROM tokens WHERE queue_id IN (${ph})
       AND (created_at >= ? OR status IN ('waiting','serving')
            OR MAX(COALESCE(called_at, 0), COALESCE(completed_at, 0), COALESCE(cancelled_at, 0)) >= ?)`
    )
    .all(...ids, from, from);

  // ---- summary ----
  const createdInRange = tokens.filter((t) => t.created_at >= from);
  const calledInRange = tokens.filter((t) => t.called_at && t.called_at >= from);
  const waits = calledInRange.map((t) => t.called_at - t.created_at);
  const serviceTimes = tokens
    .filter((t) => t.completed_at && t.completed_at >= from && t.called_at)
    .map((t) => t.completed_at - t.called_at);
  const served = tokens.filter((t) => t.status === 'served' && t.completed_at >= from).length;
  const cancelled = tokens.filter((t) => t.status === 'cancelled' && t.cancelled_at >= from).length;
  const waitingNow = tokens.filter((t) => t.status === 'waiting');
  const servingNow = tokens.filter((t) => t.status === 'serving').length;
  const closed = served + cancelled;

  // ---- queue length over time (sampled) ----
  const exitOf = (t) => t.called_at ?? t.cancelled_at ?? Infinity;
  const lengthTrend = [];
  let peakLength = 0;
  const sampleStart = from;
  for (let t = sampleStart; t <= now; t += cfg.sample) {
    let n = 0;
    for (const tok of tokens) if (tok.created_at <= t && exitOf(tok) > t) n++;
    peakLength = Math.max(peakLength, n);
    lengthTrend.push({ t, length: n });
  }
  const nowLen = waitingNow.length;
  peakLength = Math.max(peakLength, nowLen);
  if (!lengthTrend.length || lengthTrend[lengthTrend.length - 1].t !== now) lengthTrend.push({ t: now, length: nowLen });

  // ---- bucketed wait time + throughput ----
  const buckets = [];
  for (let b = from; b <= now; b += cfg.bucket) {
    buckets.push({ t: b, waits: [], arrivals: 0, served: 0, cancelled: 0 });
  }
  const bucketOf = (ts) => {
    const start = alignDown(ts, cfg.bucket);
    return buckets.find((b) => b.t === start);
  };
  for (const tok of tokens) {
    {
      const b = tok.created_at >= from && bucketOf(tok.created_at);
      if (b) b.arrivals++;
    }
    if (tok.called_at && tok.called_at >= from) {
      const b = bucketOf(tok.called_at);
      if (b) b.waits.push(tok.called_at - tok.created_at);
    }
    if (tok.status === 'served' && tok.completed_at >= from) {
      const b = bucketOf(tok.completed_at);
      if (b) b.served++;
    }
    if (tok.status === 'cancelled' && tok.cancelled_at >= from) {
      const b = bucketOf(tok.cancelled_at);
      if (b) b.cancelled++;
    }
  }

  // ---- busiest hours of the day ----
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, arrivals: 0 }));
  for (const tok of createdInRange) {
    const h = new Date(tok.created_at + shift).getUTCHours();
    hourly[h].arrivals++;
  }

  // ---- per queue ----
  const perQueue = queues.map((qu) => {
    const mine = tokens.filter((t) => t.queue_id === qu.id);
    const w = mine.filter((t) => t.called_at && t.called_at >= from).map((t) => t.called_at - t.created_at);
    return {
      id: qu.id,
      name: qu.name,
      waiting: mine.filter((t) => t.status === 'waiting').length,
      served: mine.filter((t) => t.status === 'served' && t.completed_at >= from).length,
      cancelled: mine.filter((t) => t.status === 'cancelled' && t.cancelled_at >= from).length,
      avgWaitMs: round(avg(w)),
    };
  });

  return {
    range,
    from,
    to: now,
    bucket: cfg.bucket === DAY ? 'day' : 'hour',
    summary: {
      totalTokens: createdInRange.length,
      served,
      cancelled,
      waitingNow: waitingNow.length,
      servingNow,
      avgWaitMs: round(avg(waits)),
      medianWaitMs: round(percentile(waits, 50)),
      p90WaitMs: round(percentile(waits, 90)),
      maxWaitMs: waits.length ? Math.max(...waits) : null,
      avgServiceMs: round(avg(serviceTimes)),
      cancellationRate: closed ? cancelled / closed : null,
      longestWaitingNowMs: waitingNow.length ? now - Math.min(...waitingNow.map((t) => t.created_at)) : null,
      peakLength,
    },
    waitTrend: buckets.map((b) => ({
      t: b.t,
      avgWaitMs: round(avg(b.waits)),
      maxWaitMs: b.waits.length ? Math.max(...b.waits) : null,
      count: b.waits.length,
    })),
    throughput: buckets.map((b) => ({ t: b.t, arrivals: b.arrivals, served: b.served, cancelled: b.cancelled })),
    lengthTrend,
    hourly,
    perQueue,
  };
}

module.exports = { computeAnalytics };
