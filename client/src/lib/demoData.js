// Browser port of server/src/seed.js: ~2 weeks of realistic history for the demo account.
const MIN = 60_000;
export const DEMO_EMAIL = 'demo@queuely.app';
const DEMO_SALT = 'demo-salt';
const DEMO_HASH = '04c88dccabe1af11dec1c135d49914ba6995bad0986964b43e09f410198a7615'; // sha256("demo-salt:demo1234")

const FIRST = ['Aarav', 'Diya', 'Rohan', 'Ananya', 'Vivaan', 'Meera', 'Arjun', 'Isha', 'Kabir', 'Sara', 'Nikhil', 'Priya',
  'Aditya', 'Fathima', 'Joel', 'Anjali', 'Rahul', 'Neha', 'Varun', 'Lakshmi', 'Tom', 'Aisha', 'Kiran', 'Devika', 'Manu', 'Riya'];
const LAST = ['Menon', 'Nair', 'Pillai', 'Sharma', 'Iyer', 'Thomas', 'Joseph', 'Varghese', 'Khan', 'Reddy', 'Das', 'Kurian'];
const PROFILE = { 9: 0.7, 10: 1.0, 11: 1.3, 12: 1.6, 13: 1.4, 14: 0.9, 15: 0.8, 16: 1.1, 17: 1.2 };
const QUEUES = [
  { name: 'General Consultation', prefix: 'GC', perHour: 7, service: 7 },
  { name: 'Pharmacy Pickup', prefix: 'PH', perHour: 11, service: 4 },
  { name: 'Billing & Payments', prefix: 'BL', perHour: 5, service: 6 },
];

const key = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8);

/** (Re)creates the demo account's queues inside `db`, keeping any other accounts intact. */
export function generateDemoData(db) {
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const expo = (mean) => -Math.log(1 - rand()) * mean;
  const now = Date.now();

  let demo = db.managers.find((m) => m.email === DEMO_EMAIL);
  if (demo) {
    const old = new Set(db.queues.filter((q) => q.manager_id === demo.id).map((q) => q.id));
    db.queues = db.queues.filter((q) => !old.has(q.id));
    db.tokens = db.tokens.filter((t) => !old.has(t.queue_id));
  } else {
    demo = { id: ++db.seq.manager, name: 'Demo Manager', email: DEMO_EMAIL, salt: DEMO_SALT, password_hash: DEMO_HASH, created_at: now - 20 * 24 * 60 * MIN };
    db.managers.push(demo);
  }

  for (const cfg of QUEUES) {
    const q = { id: ++db.seq.queue, manager_id: demo.id, name: cfg.name, prefix: cfg.prefix, next_number: 1, display_key: key(), created_at: now - 15 * 24 * 60 * MIN };
    db.queues.push(q);
    let number = 1;
    let position = 1;
    const push = (t) => {
      db.tokens.push({ id: ++db.seq.token, queue_id: q.id, number, code: `${cfg.prefix}-${String(number).padStart(3, '0')}`, position: position++, phone: null, ...t });
      number++;
    };

    for (let dayAgo = 14; dayAgo >= 0; dayAgo--) {
      const day = new Date(now);
      day.setDate(day.getDate() - dayAgo);
      day.setHours(9, 0, 0, 0);
      const dayFactor = (day.getDay() === 0 ? 0.45 : 1) * (0.8 + rand() * 0.45);
      let serverFree = day.getTime();
      let t = day.getTime();
      const close = day.getTime() + 9 * 60 * MIN;
      for (;;) {
        t += expo(60 / (cfg.perHour * 1.3)) * MIN;
        if (t >= close || t > now) break;
        if (rand() > ((PROFILE[new Date(t).getHours()] || 0) * dayFactor) / 1.6) continue;
        const created = Math.round(t);
        const start = Math.max(created, serverFree) + Math.round(rand() * 1.5 * MIN);
        const svc = Math.round(Math.max(1.2, expo(cfg.service)) * MIN);
        const row = { person_name: `${pick(FIRST)} ${pick(LAST)}`, created_at: created, called_at: null, completed_at: null, cancelled_at: null };
        if (rand() < 0.07) {
          const leaveAt = created + Math.round((3 + rand() * 15) * MIN);
          if (leaveAt < start && leaveAt <= now) { push({ ...row, status: 'cancelled', cancelled_at: leaveAt }); continue; }
        }
        if (start > now) push({ ...row, status: 'waiting' });
        else if (start + svc > now) { push({ ...row, status: 'serving', called_at: start }); serverFree = start + svc; }
        else { push({ ...row, status: 'served', called_at: start, completed_at: start + svc }); serverFree = start + svc; }
      }
    }

    const mine = db.tokens.filter((x) => x.queue_id === q.id);
    if (!mine.some((x) => x.status === 'waiting' || x.status === 'serving')) {
      const n = 3 + Math.floor(rand() * 4);
      let created = now - n * 7 * MIN;
      for (let i = 0; i < n; i++) {
        created = Math.min(created + Math.round((4 + rand() * 5) * MIN), now - (n - i) * MIN);
        push({ person_name: `${pick(FIRST)} ${pick(LAST)}`, status: i === 0 ? 'serving' : 'waiting', created_at: created,
          called_at: i === 0 ? now - 2 * MIN : null, completed_at: null, cancelled_at: null });
      }
    }
    const serving = db.tokens.filter((x) => x.queue_id === q.id && x.status === 'serving').sort((a, b) => a.called_at - b.called_at);
    for (const s of serving.slice(0, -1)) Object.assign(s, { status: 'served', completed_at: now - MIN });
    q.next_number = number;
  }
  db.demoSeededAt = now;
}
