const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS managers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS queues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_id  INTEGER NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  prefix      TEXT    NOT NULL DEFAULT 'A',
  next_number INTEGER NOT NULL DEFAULT 1,
  display_key TEXT    NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- status: waiting -> serving -> served   |   waiting -> cancelled
CREATE TABLE IF NOT EXISTS tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id     INTEGER NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  code         TEXT    NOT NULL,
  person_name  TEXT    NOT NULL,
  phone        TEXT,
  status       TEXT    NOT NULL CHECK (status IN ('waiting','serving','served','cancelled')),
  position     REAL    NOT NULL,
  created_at   INTEGER NOT NULL,
  called_at    INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  UNIQUE (queue_id, number)
);

CREATE INDEX IF NOT EXISTS idx_tokens_queue_status ON tokens(queue_id, status, position);
CREATE INDEX IF NOT EXISTS idx_tokens_created ON tokens(created_at);
`;

function openDb(file) {
  const target = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'queuely.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
