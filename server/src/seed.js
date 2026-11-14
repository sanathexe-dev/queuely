/**
 * Seeds a demo manager with three queues and ~2 weeks of realistic history,
 * so the dashboard has something to show. Safe to re-run: it resets the demo account only.
 *
 *   npm run seed            -> demo@queuely.app / demo1234
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { openDb } = require('./db');

const db = openDb();
const MIN = 60_000;

const FIRST = ['Aarav', 'Diya', 'Rohan', 'Ananya', 'Vivaan', 'Meera', 'Arjun', 'Isha', 'Kabir', 'Sara', 'Nikhil', 'Priya',
  'Aditya', 'Fathima', 'Joel', 'Anjali', 'Rahul', 'Neha', 'Varun', 'Lakshmi', 'Tom', 'Aisha', 'Kiran', 'Devika', 'Manu', 'Riya'];
const LAST = ['Menon', 'Nair', 'Pillai', 'Sharma', 'Iyer', 'Thomas', 'Joseph', 'Varghese', 'Khan', 'Reddy', 'Das', 'Kurian'];

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const expo = (mean) => -Math.log(1 - rand()) * mean;

// Relative arrival intensity by local hour (open 9:00–18:00, lunch rush + evening bump)
const PROFILE = { 9: 0.7, 10: 1.0, 11: 1.3, 12: 1.6, 13: 1.4, 14: 0.9, 15: 0.8, 16: 1.1, 17: 1.2 };

const QUEUES = [
  { name: 'General Consultation', prefix: 'GC', perHour: 7, service: 7 },
  { name: 'Pharmacy Pickup', prefix: 'PH', perHour: 11, service: 4 },
  { name: 'Billing & Payments', prefix: 'BL', perHour: 5, service: 6 },
];

const run = db.transaction(() => {
  const email = 'demo@queuely.app';
  db.prepare('DELETE FROM managers WHERE email = ?').run(email);
  const managerId = db
    .prepare('INSERT INTO managers (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run('Demo Manager', email, bcrypt.hashSync('demo1234', 10), Date.now() - 20 * 24 * 60 * MIN).lastInsertRowid;

  const insertQueue = db.prepare(
    'INSERT INTO queues (manager_id, name, prefix, display_key, next_number, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertToken = db.prepare(`
    INSERT INTO tokens (queue_id, number, code, person_name, phone, status, position, created_at, called_at, completed_at, cancelled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const now = Date.now();
  let totals = 0;

  for (const cfg of QUEUES) {
    const queueId = insertQueue.run(managerId, cfg.name, cfg.prefix, crypto.randomBytes(9).toString('base64url'), 1,
      now - 15 * 24 * 60 * MIN).lastInsertRowid;
    let number = 1;
    let position = 1;

    for (let dayAgo = 14; dayAgo >= 0; dayAgo--) {
      const day = new Date(now);
      day.setDate(day.getDate() - dayAgo);
      day.setHours(9, 0, 0, 0);
      const weekend = day.getDay() === 0;
      const dayFactor = (weekend ? 0.45 : 1) * (0.8 + rand() * 0.45);
      let serverFree = day.getTime();

      // generate arrivals with a non-homogeneous Poisson process
      let t = day.getTime();
      const close = day.getTime() + 9 * 60 * MIN;
      while (true) {
        t += expo(60 / (cfg.perHour * 1.3)) * MIN;
        if (t >= close || t > now) break;
        const h = new Date(t).getHours();
        if (rand() > ((PROFILE[h] || 0) * dayFactor) / 1.6) continue; // thinning

        const name = `${pick(FIRST)} ${pick(LAST)}`;
        const phone = rand() < 0.6 ? `+91 9${Math.floor(100000000 + rand() * 899999999)}` : null;
        const code = `${cfg.prefix}-${String(number).padStart(3, '0')}`;
        const created = Math.round(t);
        const start = Math.max(created, serverFree) + Math.round(rand() * 1.5 * MIN);
        const svc = Math.round(Math.max(1.2, expo(cfg.service)) * MIN);
        const abandons = rand() < 0.07;

        let status, called = null, completed = null, cancelled = null;
        if (abandons) {
          const leaveAt = created + Math.round((3 + rand() * 15) * MIN);
          if (leaveAt < start && leaveAt <= now) { status = 'cancelled'; cancelled = leaveAt; }
        }
        if (!status) {
          if (start > now) status = 'waiting';
          else if (start + svc > now) { status = 'serving'; called = start; serverFree = start + svc; }
          else { status = 'served'; called = start; completed = start + svc; serverFree = completed; }
        }
        insertToken.run(queueId, number, code, name, phone, status, position++, created, called, completed, cancelled);
        number++;
        totals++;
      }
    }
    // Outside opening hours there would be nobody waiting; add a live queue so the demo isn't empty.
    const live = db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE queue_id = ? AND status IN ('waiting','serving')").get(queueId).n;
    if (live === 0) {
      const n = 3 + Math.floor(rand() * 4);
      let created = now - n * 7 * MIN;
      for (let i = 0; i < n; i++) {
        created += Math.round((4 + rand() * 5) * MIN);
        if (created > now) created = now - (n - i) * MIN;
        const isServing = i === 0;
        insertToken.run(queueId, number, `${cfg.prefix}-${String(number).padStart(3, '0')}`, `${pick(FIRST)} ${pick(LAST)}`,
          null, isServing ? 'serving' : 'waiting', position++, created, isServing ? now - 2 * MIN : null, null, null);
        number++;
        totals++;
      }
    }
    // keep at most one "serving" token per queue (single-counter model)
    const serving = db.prepare("SELECT id FROM tokens WHERE queue_id = ? AND status = 'serving' ORDER BY called_at").all(queueId);
    for (const s of serving.slice(0, -1)) {
      db.prepare("UPDATE tokens SET status = 'served', completed_at = ? WHERE id = ?").run(now - MIN, s.id);
    }
    db.prepare('UPDATE queues SET next_number = ? WHERE id = ?').run(number, queueId);
  }
  return totals;
});

const count = run();
console.log(`Seeded demo account with ${count} tokens.\n  email:    demo@queuely.app\n  password: demo1234`);
