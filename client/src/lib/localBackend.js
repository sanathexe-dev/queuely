/**
 * Static demo mode (GitHub Pages).
 *
 * GitHub Pages can only serve static files, so in this build the REST API is
 * emulated in the browser. Every route, validation rule, status code and error
 * message mirrors server/src/app.js; data is kept in localStorage per visitor.
 * The real backend (Express + SQLite) is untouched and used by `npm start`.
 */
import { computeAnalytics } from './analyticsCore';
import { generateDemoData } from './demoData';

const DEMO_REFRESH_MS = 6 * 60 * 60 * 1000; // keep the demo's "live" queue looking current

const STORE_KEY = 'queuely.static.db.v1';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------- storage ----------------
function emptyDb() {
  return { seq: { manager: 0, queue: 0, token: 0 }, managers: [], queues: [], tokens: [], sessions: {} };
}

let db = null;
function load() {
  if (db) return db;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    db = raw ? JSON.parse(raw) : null;
  } catch {
    db = null;
  }
  if (!db) db = emptyDb();
  if (!db.demoSeededAt || Date.now() - db.demoSeededAt > DEMO_REFRESH_MS) {
    generateDemoData(db); // only the demo account is regenerated; other accounts are kept
    save();
  }
  return db;
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    /* storage full or blocked: keep working in memory */
  }
}

async function hash(password, salt) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
const randomKey = (bytes = 12) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);

// ---------------- helpers (mirror the server) ----------------
function cleanString(value, field, { min = 1, max = 80, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const v = value.trim().replace(/\s+/g, ' ');
  if (required && v.length < min) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return v || null;
}
function cleanPrefix(raw) {
  if (raw === undefined || raw === null || raw === '') return 'A';
  if (typeof raw !== 'string' || !/^[A-Za-z]{1,3}$/.test(raw.trim())) throw new HttpError(400, 'Prefix must be 1–3 letters');
  return raw.trim().toUpperCase();
}
const parseId = (raw) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
  return id;
};
const publicManager = (m) => ({ id: m.id, name: m.name, email: m.email, created_at: m.created_at });
const publicQueue = (q) => ({ id: q.id, name: q.name, prefix: q.prefix, displayKey: q.display_key, createdAt: q.created_at, nextNumber: q.next_number });
const publicToken = (t) => ({
  id: t.id, queueId: t.queue_id, number: t.number, code: t.code, name: t.person_name, phone: t.phone, status: t.status,
  createdAt: t.created_at, calledAt: t.called_at, completedAt: t.completed_at, cancelledAt: t.cancelled_at,
});
const byPos = (a, b) => a.position - b.position || a.id - b.id;
const waitingOf = (qid) => db.tokens.filter((t) => t.queue_id === qid && t.status === 'waiting').sort(byPos);
const servingOf = (qid) => db.tokens.filter((t) => t.queue_id === qid && t.status === 'serving').sort((a, b) => a.called_at - b.called_at || a.id - b.id);
const recentOf = (qid) => db.tokens
  .filter((t) => t.queue_id === qid && (t.status === 'served' || t.status === 'cancelled'))
  .sort((a, b) => (b.completed_at || b.cancelled_at) - (a.completed_at || a.cancelled_at) || b.id - a.id)
  .slice(0, 15);

function snapshot(q) {
  return {
    queue: publicQueue(q),
    waiting: waitingOf(q.id).map(publicToken),
    serving: servingOf(q.id).map(publicToken),
    recent: recentOf(q.id).map(publicToken),
    serverTime: Date.now(),
  };
}
function authed(token) {
  const managerId = token && db.sessions[token];
  const manager = managerId && db.managers.find((m) => m.id === managerId);
  if (!manager) throw new HttpError(401, token ? 'Session expired, please sign in again' : 'Please sign in');
  return manager;
}
function ownedQueue(manager, rawId) {
  const q = db.queues.find((x) => x.id === parseId(rawId) && x.manager_id === manager.id);
  if (!q) throw new HttpError(404, 'Queue not found');
  return q;
}
function ownedToken(manager, rawId) {
  const t = db.tokens.find((x) => x.id === parseId(rawId));
  if (!t || !db.queues.some((q) => q.id === t.queue_id && q.manager_id === manager.id)) throw new HttpError(404, 'Token not found');
  return t;
}
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function signIn(manager) {
  const token = randomKey(24);
  db.sessions[token] = manager.id;
  return { token, manager: publicManager(manager) };
}

// ---------------- routes ----------------
async function handle(method, path, body, token) {
  load();
  const [pathname, qs] = path.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  const seg = pathname.split('/').filter(Boolean);
  const is = (m, pattern) => {
    if (m !== method) return null;
    const parts = pattern.split('/').filter(Boolean);
    if (parts.length !== seg.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(seg[i]);
      else if (parts[i] !== seg[i]) return null;
    }
    return params;
  };
  let p;

  // ---- auth ----
  if (is('POST', '/auth/register')) {
    const name = cleanString(body?.name, 'Name', { max: 60 });
    const email = cleanString(body?.email, 'Email', { max: 120 }).toLowerCase();
    const password = body?.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
    if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    if (db.managers.some((m) => m.email === email)) throw new HttpError(409, 'An account with this email already exists');
    const salt = randomKey(8);
    const manager = { id: ++db.seq.manager, name, email, salt, password_hash: await hash(password, salt), created_at: Date.now() };
    db.managers.push(manager);
    return signIn(manager);
  }
  if (is('POST', '/auth/login')) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) throw new HttpError(400, 'Email and password are required');
    const m = db.managers.find((x) => x.email === email);
    if (!m || (await hash(password, m.salt)) !== m.password_hash) throw new HttpError(401, 'Invalid email or password');
    return signIn(m);
  }
  if (is('GET', '/auth/me')) return { manager: publicManager(authed(token)) };

  // ---- public display ----
  if ((p = is('GET', '/display/:key'))) {
    const q = db.queues.find((x) => x.display_key === p.key);
    if (!q) throw new HttpError(404, 'Display not found');
    const first = (n) => n.split(' ')[0];
    const waiting = waitingOf(q.id);
    return {
      name: q.name,
      serving: servingOf(q.id).map((t) => ({ code: t.code, name: first(t.person_name), calledAt: t.called_at })),
      next: waiting.slice(0, 8).map((t) => ({ code: t.code, name: first(t.person_name) })),
      waitingCount: waiting.length,
      serverTime: Date.now(),
    };
  }

  const me = authed(token);

  // ---- queues ----
  if (is('GET', '/queues')) {
    const since = startOfToday();
    const queues = db.queues
      .filter((q) => q.manager_id === me.id)
      .sort((a, b) => b.created_at - a.created_at || b.id - a.id)
      .map((q) => {
        const mine = db.tokens.filter((t) => t.queue_id === q.id);
        const waits = mine.filter((t) => t.called_at && t.called_at >= since).map((t) => t.called_at - t.created_at);
        return {
          ...publicQueue(q),
          waitingCount: mine.filter((t) => t.status === 'waiting').length,
          servingCount: mine.filter((t) => t.status === 'serving').length,
          servedToday: mine.filter((t) => t.status === 'served' && t.completed_at >= since).length,
          avgWaitMs: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
        };
      });
    return { queues };
  }
  if (is('POST', '/queues')) {
    const name = cleanString(body?.name, 'Queue name', { max: 60 });
    const prefix = cleanPrefix(body?.prefix);
    const q = { id: ++db.seq.queue, manager_id: me.id, name, prefix, next_number: 1, display_key: randomKey(9), created_at: Date.now() };
    db.queues.push(q);
    return { queue: publicQueue(q) };
  }
  if ((p = is('GET', '/queues/:id'))) return snapshot(ownedQueue(me, p.id));
  if ((p = is('PATCH', '/queues/:id'))) {
    const q = ownedQueue(me, p.id);
    if (body?.name !== undefined) q.name = cleanString(body.name, 'Queue name', { max: 60 });
    if (body?.prefix !== undefined) q.prefix = cleanPrefix(body.prefix);
    return snapshot(q);
  }
  if ((p = is('DELETE', '/queues/:id'))) {
    const q = ownedQueue(me, p.id);
    db.queues = db.queues.filter((x) => x.id !== q.id);
    db.tokens = db.tokens.filter((t) => t.queue_id !== q.id);
    return null;
  }

  // ---- tokens ----
  if ((p = is('POST', '/queues/:id/tokens'))) {
    const q = ownedQueue(me, p.id);
    const name = cleanString(body?.name, 'Name', { max: 60 });
    const phone = cleanString(body?.phone, 'Phone', { required: false, max: 20 });
    if (phone && !/^[+\d][\d\s-]{3,19}$/.test(phone)) throw new HttpError(400, 'Enter a valid phone number');
    const waiting = waitingOf(q.id);
    const number = q.next_number++;
    const t = {
      id: ++db.seq.token, queue_id: q.id, number, code: `${q.prefix}-${String(number).padStart(3, '0')}`,
      person_name: name, phone, status: 'waiting',
      position: waiting.length ? Math.max(...waiting.map((x) => x.position)) + 1 : 1,
      created_at: Date.now(), called_at: null, completed_at: null, cancelled_at: null,
    };
    db.tokens.push(t);
    return { token: publicToken(t), ...snapshot(q) };
  }
  if ((p = is('POST', '/tokens/:id/move'))) {
    const t = ownedToken(me, p.id);
    if (t.status !== 'waiting') throw new HttpError(409, 'Only waiting tokens can be moved');
    const dir = body?.direction;
    if (!['up', 'down', 'top', 'bottom'].includes(dir)) throw new HttpError(400, 'Direction must be up, down, top or bottom');
    const list = waitingOf(t.queue_id);
    const i = list.findIndex((x) => x.id === t.id);
    if (dir === 'up' && i > 0) [t.position, list[i - 1].position] = [list[i - 1].position, t.position];
    if (dir === 'down' && i < list.length - 1) [t.position, list[i + 1].position] = [list[i + 1].position, t.position];
    if (dir === 'top' && i > 0) t.position = list[0].position - 1;
    if (dir === 'bottom' && i < list.length - 1) t.position = list[list.length - 1].position + 1;
    return snapshot(db.queues.find((q) => q.id === t.queue_id));
  }
  if ((p = is('POST', '/queues/:id/serve-next'))) {
    const q = ownedQueue(me, p.id);
    const [top] = waitingOf(q.id);
    if (!top) throw new HttpError(409, 'No one is waiting in this queue');
    const now = Date.now();
    for (const s of servingOf(q.id)) Object.assign(s, { status: 'served', completed_at: now });
    Object.assign(top, { status: 'serving', called_at: now });
    return { token: publicToken(top), ...snapshot(q) };
  }
  if ((p = is('POST', '/tokens/:id/complete'))) {
    const t = ownedToken(me, p.id);
    if (t.status !== 'serving') throw new HttpError(409, 'Only the token being served can be completed');
    Object.assign(t, { status: 'served', completed_at: Date.now() });
    return snapshot(db.queues.find((q) => q.id === t.queue_id));
  }
  if ((p = is('POST', '/tokens/:id/cancel'))) {
    const t = ownedToken(me, p.id);
    if (t.status !== 'waiting' && t.status !== 'serving') throw new HttpError(409, `Token is already ${t.status}`);
    Object.assign(t, { status: 'cancelled', cancelled_at: Date.now() });
    return snapshot(db.queues.find((q) => q.id === t.queue_id));
  }

  // ---- analytics ----
  if (is('GET', '/analytics')) {
    const range = ['24h', '7d', '30d'].includes(query.range) ? query.range : '7d';
    const tz = Number.isFinite(Number(query.tz)) ? Math.max(-840, Math.min(840, Number(query.tz))) : 0;
    let queues = db.queues.filter((q) => q.manager_id === me.id).map((q) => ({ id: q.id, name: q.name }));
    if (query.queueId && query.queueId !== 'all') {
      const id = parseId(query.queueId);
      queues = queues.filter((q) => q.id === id);
      if (!queues.length) throw new HttpError(404, 'Queue not found');
    }
    return computeAnalytics(db.tokens, { queues, range, tzOffset: tz, now: Date.now() });
  }

  throw new HttpError(404, 'Endpoint not found');
}

/** Same contract as fetch-based api(): resolves with JSON, rejects with {status, message}. */
export async function localRequest(path, { method = 'GET', body, token } = {}) {
  await new Promise((r) => setTimeout(r, 60)); // feel like a network call, keep async ordering realistic
  try {
    const result = await handle(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)), token);
    if (method !== 'GET') save();
    return result;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(err);
    throw new HttpError(500, 'Something went wrong');
  }
}

/** Wipe this browser's data and restore the demo account. */
export function resetLocalData() {
  db = emptyDb();
  generateDemoData(db);
  save();
}
