const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { computeAnalytics } = require('./analytics');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const TOKEN_TTL = '7d';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

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

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
  return id;
}

function createApp(db) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  // ---------- prepared statements ----------
  const q = {
    managerByEmail: db.prepare('SELECT * FROM managers WHERE email = ?'),
    managerById: db.prepare('SELECT id, name, email, created_at FROM managers WHERE id = ?'),
    insertManager: db.prepare(
      'INSERT INTO managers (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)'
    ),
    queueOwned: db.prepare('SELECT * FROM queues WHERE id = ? AND manager_id = ?'),
    queueByDisplayKey: db.prepare('SELECT * FROM queues WHERE display_key = ?'),
    insertQueue: db.prepare(
      'INSERT INTO queues (manager_id, name, prefix, display_key, created_at) VALUES (?, ?, ?, ?, ?)'
    ),
    renameQueue: db.prepare('UPDATE queues SET name = ?, prefix = ? WHERE id = ?'),
    deleteQueue: db.prepare('DELETE FROM queues WHERE id = ?'),
    listQueues: db.prepare(`
      SELECT q.*,
        (SELECT COUNT(*) FROM tokens t WHERE t.queue_id = q.id AND t.status = 'waiting') AS waiting_count,
        (SELECT COUNT(*) FROM tokens t WHERE t.queue_id = q.id AND t.status = 'serving') AS serving_count,
        (SELECT COUNT(*) FROM tokens t WHERE t.queue_id = q.id AND t.status = 'served' AND t.completed_at >= @since) AS served_today,
        (SELECT AVG(t.called_at - t.created_at) FROM tokens t WHERE t.queue_id = q.id AND t.called_at >= @since) AS avg_wait_ms
      FROM queues q WHERE q.manager_id = @managerId ORDER BY q.created_at DESC, q.id DESC`),
    tokenOwned: db.prepare(`
      SELECT t.* FROM tokens t JOIN queues q ON q.id = t.queue_id
      WHERE t.id = ? AND q.manager_id = ?`),
    waiting: db.prepare(
      "SELECT * FROM tokens WHERE queue_id = ? AND status = 'waiting' ORDER BY position ASC, id ASC"
    ),
    serving: db.prepare(
      "SELECT * FROM tokens WHERE queue_id = ? AND status = 'serving' ORDER BY called_at ASC, id ASC"
    ),
    recent: db.prepare(`
      SELECT * FROM tokens WHERE queue_id = ? AND status IN ('served','cancelled')
      ORDER BY COALESCE(completed_at, cancelled_at) DESC, id DESC LIMIT 15`),
    maxPosition: db.prepare(
      "SELECT MAX(position) AS m FROM tokens WHERE queue_id = ? AND status = 'waiting'"
    ),
    minPosition: db.prepare(
      "SELECT MIN(position) AS m FROM tokens WHERE queue_id = ? AND status = 'waiting'"
    ),
    bumpNumber: db.prepare('UPDATE queues SET next_number = next_number + 1 WHERE id = ?'),
    insertToken: db.prepare(`
      INSERT INTO tokens (queue_id, number, code, person_name, phone, status, position, created_at)
      VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`),
    prevWaiting: db.prepare(`
      SELECT * FROM tokens WHERE queue_id = ? AND status = 'waiting'
        AND (position < @pos OR (position = @pos AND id < @id))
      ORDER BY position DESC, id DESC LIMIT 1`),
    nextWaiting: db.prepare(`
      SELECT * FROM tokens WHERE queue_id = ? AND status = 'waiting'
        AND (position > @pos OR (position = @pos AND id > @id))
      ORDER BY position ASC, id ASC LIMIT 1`),
    setPosition: db.prepare('UPDATE tokens SET position = ? WHERE id = ?'),
    callToken: db.prepare(
      "UPDATE tokens SET status = 'serving', called_at = ? WHERE id = ? AND status = 'waiting'"
    ),
    completeServing: db.prepare(
      "UPDATE tokens SET status = 'served', completed_at = ? WHERE queue_id = ? AND status = 'serving'"
    ),
    completeToken: db.prepare(
      "UPDATE tokens SET status = 'served', completed_at = ? WHERE id = ? AND status = 'serving'"
    ),
    cancelToken: db.prepare(
      "UPDATE tokens SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status IN ('waiting','serving')"
    ),
  };

  // ---------- helpers ----------
  const publicToken = (t) => ({
    id: t.id,
    queueId: t.queue_id,
    number: t.number,
    code: t.code,
    name: t.person_name,
    phone: t.phone,
    status: t.status,
    createdAt: t.created_at,
    calledAt: t.called_at,
    completedAt: t.completed_at,
    cancelledAt: t.cancelled_at,
  });

  const publicQueue = (row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    displayKey: row.display_key,
    createdAt: row.created_at,
    nextNumber: row.next_number,
  });

  function snapshot(queueRow) {
    return {
      queue: publicQueue(queueRow),
      waiting: q.waiting.all(queueRow.id).map(publicToken),
      serving: q.serving.all(queueRow.id).map(publicToken),
      recent: q.recent.all(queueRow.id).map(publicToken),
      serverTime: Date.now(),
    };
  }

  function sign(manager) {
    return jwt.sign({ sub: manager.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  }

  function auth(req, _res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return next(new HttpError(401, 'Please sign in'));
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const manager = q.managerById.get(payload.sub);
      if (!manager) return next(new HttpError(401, 'Account no longer exists'));
      req.manager = manager;
      next();
    } catch {
      next(new HttpError(401, 'Session expired, please sign in again'));
    }
  }

  function ownedQueue(req) {
    const queue = q.queueOwned.get(parseId(req.params.id), req.manager.id);
    if (!queue) throw new HttpError(404, 'Queue not found');
    return queue;
  }

  function ownedToken(req) {
    const token = q.tokenOwned.get(parseId(req.params.id), req.manager.id);
    if (!token) throw new HttpError(404, 'Token not found');
    return token;
  }

  function cleanPrefix(raw) {
    if (raw === undefined || raw === null || raw === '') return 'A';
    if (typeof raw !== 'string' || !/^[A-Za-z]{1,3}$/.test(raw.trim())) {
      throw new HttpError(400, 'Prefix must be 1–3 letters');
    }
    return raw.trim().toUpperCase();
  }

  const startOfToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  // ---------- auth ----------
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post(
    '/api/auth/register',
    wrap((req, res) => {
      const name = cleanString(req.body?.name, 'Name', { max: 60 });
      const email = cleanString(req.body?.email, 'Email', { max: 120 }).toLowerCase();
      const password = req.body?.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
      if (typeof password !== 'string' || password.length < 6) {
        throw new HttpError(400, 'Password must be at least 6 characters');
      }
      if (password.length > 200) throw new HttpError(400, 'Password is too long');
      if (q.managerByEmail.get(email)) throw new HttpError(409, 'An account with this email already exists');
      const hash = bcrypt.hashSync(password, 10);
      const info = q.insertManager.run(name, email, hash, Date.now());
      const manager = q.managerById.get(info.lastInsertRowid);
      res.status(201).json({ token: sign(manager), manager });
    })
  );

  app.post(
    '/api/auth/login',
    wrap((req, res) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!email || !password) throw new HttpError(400, 'Email and password are required');
      const row = q.managerByEmail.get(email);
      if (!row || !bcrypt.compareSync(password, row.password_hash)) {
        throw new HttpError(401, 'Invalid email or password');
      }
      const manager = q.managerById.get(row.id);
      res.json({ token: sign(manager), manager });
    })
  );

  app.get('/api/auth/me', auth, (req, res) => res.json({ manager: req.manager }));

  // ---------- queues ----------
  app.get(
    '/api/queues',
    auth,
    wrap((req, res) => {
      const rows = q.listQueues.all({ managerId: req.manager.id, since: startOfToday() });
      res.json({
        queues: rows.map((r) => ({
          ...publicQueue(r),
          waitingCount: r.waiting_count,
          servingCount: r.serving_count,
          servedToday: r.served_today,
          avgWaitMs: r.avg_wait_ms === null ? null : Math.round(r.avg_wait_ms),
        })),
      });
    })
  );

  app.post(
    '/api/queues',
    auth,
    wrap((req, res) => {
      const name = cleanString(req.body?.name, 'Queue name', { max: 60 });
      const prefix = cleanPrefix(req.body?.prefix);
      const key = crypto.randomBytes(9).toString('base64url');
      const info = q.insertQueue.run(req.manager.id, name, prefix, key, Date.now());
      const row = q.queueOwned.get(info.lastInsertRowid, req.manager.id);
      res.status(201).json({ queue: publicQueue(row) });
    })
  );

  app.get('/api/queues/:id', auth, wrap((req, res) => res.json(snapshot(ownedQueue(req)))));

  app.patch(
    '/api/queues/:id',
    auth,
    wrap((req, res) => {
      const queue = ownedQueue(req);
      const name = req.body?.name !== undefined ? cleanString(req.body.name, 'Queue name', { max: 60 }) : queue.name;
      const prefix = req.body?.prefix !== undefined ? cleanPrefix(req.body.prefix) : queue.prefix;
      q.renameQueue.run(name, prefix, queue.id);
      res.json(snapshot(q.queueOwned.get(queue.id, req.manager.id)));
    })
  );

  app.delete(
    '/api/queues/:id',
    auth,
    wrap((req, res) => {
      const queue = ownedQueue(req);
      q.deleteQueue.run(queue.id);
      res.status(204).end();
    })
  );

  // ---------- tokens ----------
  const addToken = db.transaction((queue, name, phone) => {
    const fresh = db.prepare('SELECT next_number FROM queues WHERE id = ?').get(queue.id);
    const number = fresh.next_number;
    const code = `${queue.prefix}-${String(number).padStart(3, '0')}`;
    const max = q.maxPosition.get(queue.id).m;
    const position = max === null ? 1 : max + 1;
    q.bumpNumber.run(queue.id);
    const info = q.insertToken.run(queue.id, number, code, name, phone, position, Date.now());
    return info.lastInsertRowid;
  });

  app.post(
    '/api/queues/:id/tokens',
    auth,
    wrap((req, res) => {
      const queue = ownedQueue(req);
      const name = cleanString(req.body?.name, 'Name', { max: 60 });
      const phone = cleanString(req.body?.phone, 'Phone', { required: false, max: 20 });
      if (phone && !/^[+\d][\d\s-]{3,19}$/.test(phone)) throw new HttpError(400, 'Enter a valid phone number');
      const id = addToken(queue, name, phone);
      const token = q.tokenOwned.get(id, req.manager.id);
      res.status(201).json({ token: publicToken(token), ...snapshot(queue) });
    })
  );

  const moveToken = db.transaction((token, direction) => {
    if (direction === 'up' || direction === 'down') {
      const neighbour = (direction === 'up' ? q.prevWaiting : q.nextWaiting).get(token.queue_id, {
        pos: token.position,
        id: token.id,
      });
      if (!neighbour) return false;
      if (neighbour.position === token.position) {
        // Equal positions shouldn't happen, but make the swap meaningful if it does.
        const delta = direction === 'up' ? -0.5 : 0.5;
        q.setPosition.run(token.position + delta, token.id);
      } else {
        q.setPosition.run(neighbour.position, token.id);
        q.setPosition.run(token.position, neighbour.id);
      }
      return true;
    }
    if (direction === 'top') {
      if (!q.prevWaiting.get(token.queue_id, { pos: token.position, id: token.id })) return false;
      q.setPosition.run(q.minPosition.get(token.queue_id).m - 1, token.id);
      return true;
    }
    if (direction === 'bottom') {
      if (!q.nextWaiting.get(token.queue_id, { pos: token.position, id: token.id })) return false;
      q.setPosition.run(q.maxPosition.get(token.queue_id).m + 1, token.id);
      return true;
    }
    throw new HttpError(400, 'Direction must be up, down, top or bottom');
  });

  app.post(
    '/api/tokens/:id/move',
    auth,
    wrap((req, res) => {
      const token = ownedToken(req);
      if (token.status !== 'waiting') throw new HttpError(409, 'Only waiting tokens can be moved');
      moveToken(token, req.body?.direction);
      res.json(snapshot(q.queueOwned.get(token.queue_id, req.manager.id)));
    })
  );

  const serveNext = db.transaction((queue) => {
    const [top] = q.waiting.all(queue.id);
    if (!top) throw new HttpError(409, 'No one is waiting in this queue');
    const now = Date.now();
    q.completeServing.run(now, queue.id); // single counter: calling next finishes the current one
    q.callToken.run(now, top.id);
    return top.id;
  });

  app.post(
    '/api/queues/:id/serve-next',
    auth,
    wrap((req, res) => {
      const queue = ownedQueue(req);
      const id = serveNext(queue);
      res.json({ token: publicToken(q.tokenOwned.get(id, req.manager.id)), ...snapshot(queue) });
    })
  );

  app.post(
    '/api/tokens/:id/complete',
    auth,
    wrap((req, res) => {
      const token = ownedToken(req);
      if (token.status !== 'serving') throw new HttpError(409, 'Only the token being served can be completed');
      q.completeToken.run(Date.now(), token.id);
      res.json(snapshot(q.queueOwned.get(token.queue_id, req.manager.id)));
    })
  );

  app.post(
    '/api/tokens/:id/cancel',
    auth,
    wrap((req, res) => {
      const token = ownedToken(req);
      if (token.status !== 'waiting' && token.status !== 'serving') {
        throw new HttpError(409, `Token is already ${token.status}`);
      }
      q.cancelToken.run(Date.now(), token.id);
      res.json(snapshot(q.queueOwned.get(token.queue_id, req.manager.id)));
    })
  );

  // ---------- analytics ----------
  app.get(
    '/api/analytics',
    auth,
    wrap((req, res) => {
      const range = ['24h', '7d', '30d'].includes(req.query.range) ? req.query.range : '7d';
      const tzOffset = Number.isFinite(Number(req.query.tz)) ? Math.max(-840, Math.min(840, Number(req.query.tz))) : 0;
      let queueIds = db.prepare('SELECT id, name FROM queues WHERE manager_id = ?').all(req.manager.id);
      if (req.query.queueId && req.query.queueId !== 'all') {
        const id = parseId(req.query.queueId);
        queueIds = queueIds.filter((x) => x.id === id);
        if (!queueIds.length) throw new HttpError(404, 'Queue not found');
      }
      res.json(computeAnalytics(db, { queues: queueIds, range, tzOffset, now: Date.now() }));
    })
  );

  // ---------- public display board (no auth, unguessable key) ----------
  app.get(
    '/api/display/:key',
    wrap((req, res) => {
      const queue = q.queueByDisplayKey.get(String(req.params.key));
      if (!queue) throw new HttpError(404, 'Display not found');
      const firstName = (n) => n.split(' ')[0];
      res.json({
        name: queue.name,
        serving: q.serving.all(queue.id).map((t) => ({ code: t.code, name: firstName(t.person_name), calledAt: t.called_at })),
        next: q.waiting.all(queue.id).slice(0, 8).map((t) => ({ code: t.code, name: firstName(t.person_name) })),
        waitingCount: q.waiting.all(queue.id).length,
        serverTime: Date.now(),
      });
    })
  );

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Endpoint not found')));

  // ---------- serve built frontend ----------
  const dist = path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // ---------- errors ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  return app;
}

module.exports = { createApp, JWT_SECRET };
