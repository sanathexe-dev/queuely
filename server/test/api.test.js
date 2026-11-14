const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

const db = openDb(':memory:');
const app = createApp(db);

let auth;
let otherAuth;

async function register(email, name = 'Manager') {
  const res = await request(app).post('/api/auth/register').send({ name, email, password: 'secret123' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { Authorization: `Bearer ${res.body.token}` };
}

async function newQueue(name = 'Front desk', prefix) {
  const res = await request(app).post('/api/queues').set(auth).send({ name, prefix });
  assert.equal(res.status, 201);
  return res.body.queue;
}

async function addPeople(queueId, names) {
  let last;
  for (const name of names) {
    last = await request(app).post(`/api/queues/${queueId}/tokens`).set(auth).send({ name });
    assert.equal(last.status, 201, JSON.stringify(last.body));
  }
  return last.body;
}

const names = (snap) => snap.waiting.map((t) => t.name);

before(async () => {
  auth = await register('manager@test.dev');
  otherAuth = await register('other@test.dev');
});

describe('auth', () => {
  test('rejects duplicate email (case-insensitive)', async () => {
    const res = await request(app).post('/api/auth/register').send({ name: 'X', email: 'MANAGER@test.dev', password: 'secret123' });
    assert.equal(res.status, 409);
  });

  test('validates input', async () => {
    const res = await request(app).post('/api/auth/register').send({ name: 'X', email: 'bad', password: '1' });
    assert.equal(res.status, 400);
  });

  test('logs in with correct password only', async () => {
    const ok = await request(app).post('/api/auth/login').send({ email: 'manager@test.dev', password: 'secret123' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal(ok.body.manager.password_hash, undefined);
    const bad = await request(app).post('/api/auth/login').send({ email: 'manager@test.dev', password: 'nope' });
    assert.equal(bad.status, 401);
  });

  test('protects routes', async () => {
    assert.equal((await request(app).get('/api/queues')).status, 401);
    assert.equal((await request(app).get('/api/queues').set({ Authorization: 'Bearer junk' })).status, 401);
  });

  test('handles malformed JSON', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad');
    assert.equal(res.status, 400);
  });
});

describe('queues', () => {
  test('creates and lists queues with a name', async () => {
    const queue = await newQueue('  Billing   counter ', 'bl');
    assert.equal(queue.name, 'Billing counter');
    assert.equal(queue.prefix, 'BL');
    const list = await request(app).get('/api/queues').set(auth);
    assert.ok(list.body.queues.some((x) => x.id === queue.id && x.waitingCount === 0));
  });

  test('requires a name', async () => {
    const res = await request(app).post('/api/queues').set(auth).send({ name: '   ' });
    assert.equal(res.status, 400);
  });

  test('managers cannot see each other\'s queues', async () => {
    const queue = await newQueue('Private');
    assert.equal((await request(app).get(`/api/queues/${queue.id}`).set(otherAuth)).status, 404);
    const list = await request(app).get('/api/queues').set(otherAuth);
    assert.equal(list.body.queues.length, 0);
  });

  test('renames and deletes', async () => {
    const queue = await newQueue('Old');
    const r = await request(app).patch(`/api/queues/${queue.id}`).set(auth).send({ name: 'New' });
    assert.equal(r.body.queue.name, 'New');
    assert.equal((await request(app).delete(`/api/queues/${queue.id}`).set(auth)).status, 204);
    assert.equal((await request(app).get(`/api/queues/${queue.id}`).set(auth)).status, 404);
  });
});

describe('tokens', () => {
  test('adding a person creates a sequential token', async () => {
    const queue = await newQueue('Tokens', 'T');
    const a = await request(app).post(`/api/queues/${queue.id}/tokens`).set(auth).send({ name: 'Asha' });
    const b = await request(app).post(`/api/queues/${queue.id}/tokens`).set(auth).send({ name: 'Ben', phone: '+91 98765 43210' });
    assert.equal(a.body.token.code, 'T-001');
    assert.equal(b.body.token.code, 'T-002');
    assert.equal(b.body.token.status, 'waiting');
    assert.deepEqual(names(b.body), ['Asha', 'Ben']);
  });

  test('rejects empty name and bad phone', async () => {
    const queue = await newQueue();
    assert.equal((await request(app).post(`/api/queues/${queue.id}/tokens`).set(auth).send({ name: '' })).status, 400);
    assert.equal((await request(app).post(`/api/queues/${queue.id}/tokens`).set(auth).send({ name: 'A', phone: 'abc' })).status, 400);
  });

  test('moves tokens up and down, top and bottom', async () => {
    const queue = await newQueue();
    const snap = await addPeople(queue.id, ['A', 'B', 'C', 'D']);
    const id = (n, s = snap) => s.waiting.find((t) => t.name === n).id;

    let r = await request(app).post(`/api/tokens/${id('C')}/move`).set(auth).send({ direction: 'up' });
    assert.deepEqual(names(r.body), ['A', 'C', 'B', 'D']);
    r = await request(app).post(`/api/tokens/${id('A')}/move`).set(auth).send({ direction: 'down' });
    assert.deepEqual(names(r.body), ['C', 'A', 'B', 'D']);
    r = await request(app).post(`/api/tokens/${id('D')}/move`).set(auth).send({ direction: 'top' });
    assert.deepEqual(names(r.body), ['D', 'C', 'A', 'B']);
    r = await request(app).post(`/api/tokens/${id('D')}/move`).set(auth).send({ direction: 'bottom' });
    assert.deepEqual(names(r.body), ['C', 'A', 'B', 'D']);

    // edges are no-ops, not errors
    r = await request(app).post(`/api/tokens/${id('C')}/move`).set(auth).send({ direction: 'up' });
    assert.equal(r.status, 200);
    assert.deepEqual(names(r.body), ['C', 'A', 'B', 'D']);
    r = await request(app).post(`/api/tokens/${id('D')}/move`).set(auth).send({ direction: 'down' });
    assert.deepEqual(names(r.body), ['C', 'A', 'B', 'D']);

    const bad = await request(app).post(`/api/tokens/${id('A')}/move`).set(auth).send({ direction: 'sideways' });
    assert.equal(bad.status, 400);
  });

  test('new tokens join at the back even after reordering', async () => {
    const queue = await newQueue();
    const snap = await addPeople(queue.id, ['A', 'B']);
    await request(app).post(`/api/tokens/${snap.waiting[0].id}/move`).set(auth).send({ direction: 'bottom' });
    const r = await addPeople(queue.id, ['C']);
    assert.deepEqual(names(r), ['B', 'A', 'C']);
  });

  test('serve next assigns the top token and completes the previous one', async () => {
    const queue = await newQueue();
    await addPeople(queue.id, ['A', 'B', 'C']);
    let r = await request(app).post(`/api/queues/${queue.id}/serve-next`).set(auth);
    assert.equal(r.status, 200);
    assert.equal(r.body.token.name, 'A');
    assert.equal(r.body.serving.length, 1);
    assert.deepEqual(names(r.body), ['B', 'C']);

    r = await request(app).post(`/api/queues/${queue.id}/serve-next`).set(auth);
    assert.equal(r.body.serving[0].name, 'B');
    assert.equal(r.body.recent[0].name, 'A');
    assert.equal(r.body.recent[0].status, 'served');

    r = await request(app).post(`/api/tokens/${r.body.serving[0].id}/complete`).set(auth);
    assert.equal(r.body.serving.length, 0);

    await request(app).post(`/api/queues/${queue.id}/serve-next`).set(auth);
    const empty = await request(app).post(`/api/queues/${queue.id}/serve-next`).set(auth);
    assert.equal(empty.status, 409);
  });

  test('moved / cancelled tokens are respected by serve next', async () => {
    const queue = await newQueue();
    const snap = await addPeople(queue.id, ['A', 'B', 'C']);
    await request(app).post(`/api/tokens/${snap.waiting[0].id}/cancel`).set(auth);
    await request(app).post(`/api/tokens/${snap.waiting[2].id}/move`).set(auth).send({ direction: 'up' });
    const r = await request(app).post(`/api/queues/${queue.id}/serve-next`).set(auth);
    assert.equal(r.body.token.name, 'C');
  });

  test('cancel removes from the queue and cannot be repeated', async () => {
    const queue = await newQueue();
    const snap = await addPeople(queue.id, ['A', 'B']);
    const r = await request(app).post(`/api/tokens/${snap.waiting[0].id}/cancel`).set(auth);
    assert.deepEqual(names(r.body), ['B']);
    assert.equal(r.body.recent[0].status, 'cancelled');
    const again = await request(app).post(`/api/tokens/${snap.waiting[0].id}/cancel`).set(auth);
    assert.equal(again.status, 409);
    const move = await request(app).post(`/api/tokens/${snap.waiting[0].id}/move`).set(auth).send({ direction: 'up' });
    assert.equal(move.status, 409);
  });

  test('other managers cannot touch tokens', async () => {
    const queue = await newQueue();
    const snap = await addPeople(queue.id, ['A']);
    const id = snap.waiting[0].id;
    assert.equal((await request(app).post(`/api/tokens/${id}/cancel`).set(otherAuth)).status, 404);
    assert.equal((await request(app).post(`/api/tokens/${id}/move`).set(otherAuth).send({ direction: 'up' })).status, 404);
    assert.equal((await request(app).post(`/api/queues/${queue.id}/serve-next`).set(otherAuth)).status, 404);
    assert.equal((await request(app).post(`/api/queues/${queue.id}/tokens`).set(otherAuth).send({ name: 'X' })).status, 404);
  });

  test('public display hides full names and needs the key', async () => {
    const queue = await newQueue('Display');
    await addPeople(queue.id, ['Asha Menon']);
    const r = await request(app).get(`/api/display/${queue.displayKey}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.next[0].name, 'Asha');
    assert.equal((await request(app).get('/api/display/nope')).status, 404);
  });
});

describe('analytics', () => {
  test('computes wait times and queue length', async () => {
    const queue = await newQueue('Analytics');
    const now = Date.now();
    const ins = db.prepare(`INSERT INTO tokens (queue_id, number, code, person_name, status, position, created_at, called_at, completed_at, cancelled_at)
      VALUES (?, ?, ?, 'X', ?, ?, ?, ?, ?, ?)`);
    const m = 60_000;
    ins.run(queue.id, 101, 'A-101', 'served', 1, now - 60 * m, now - 50 * m, now - 45 * m, null); // waited 10m
    ins.run(queue.id, 102, 'A-102', 'served', 2, now - 40 * m, now - 20 * m, now - 15 * m, null); // waited 20m
    ins.run(queue.id, 103, 'A-103', 'cancelled', 3, now - 30 * m, null, null, now - 25 * m);
    ins.run(queue.id, 104, 'A-104', 'waiting', 4, now - 5 * m, null, null, null);

    for (const range of ['24h', '7d', '30d']) {
      const r = await request(app).get(`/api/analytics?queueId=${queue.id}&range=${range}&tz=-330`).set(auth);
      assert.equal(r.status, 200);
      const s = r.body.summary;
      assert.equal(s.served, 2);
      assert.equal(s.cancelled, 1);
      assert.equal(s.waitingNow, 1);
      assert.equal(s.avgWaitMs, 15 * m);
      assert.equal(s.avgServiceMs, 5 * m);
      assert.equal(s.maxWaitMs, 20 * m);
      assert.equal(r.body.lengthTrend.at(-1).length, 1);
      const arrivals = r.body.throughput.reduce((a, b) => a + b.arrivals, 0);
      assert.equal(arrivals, 4);
      assert.equal(r.body.hourly.reduce((a, b) => a + b.arrivals, 0), 4);
      assert.equal(r.body.throughput.length, range === '24h' ? 24 : range === '7d' ? 7 : 30);
    }
  });

  test('works with no queues and rejects foreign queue', async () => {
    const r = await request(app).get('/api/analytics').set(otherAuth);
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.totalTokens, 0);
    const list = await request(app).get('/api/queues').set(auth);
    const foreign = await request(app).get(`/api/analytics?queueId=${list.body.queues[0].id}`).set(otherAuth);
    assert.equal(foreign.status, 404);
  });
});
