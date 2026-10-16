'use strict';
// SQLite встроен в Node.js 22 (node:sqlite) — отдельных пакетов не нужно.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'app.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- Одна строка = одна подписка пользователя на одно приложение (199 руб/мес)
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app               TEXT NOT NULL,
  paid_until        INTEGER NOT NULL DEFAULT 0,
  auto_renew        INTEGER NOT NULL DEFAULT 1,
  payment_method_id TEXT,
  last_renew_try    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, app)
);

CREATE TABLE IF NOT EXISTS payments (
  id         TEXT PRIMARY KEY,         -- id платежа в ЮKassa
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app        TEXT NOT NULL,
  status     TEXT NOT NULL,            -- pending | succeeded | canceled
  amount     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  applied    INTEGER NOT NULL DEFAULT 0 -- 1 = подписка уже продлена за этот платёж
);

-- Данные пользователя в каждом приложении (одна JSON-запись на приложение)
CREATE TABLE IF NOT EXISTS app_data (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app        TEXT NOT NULL,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, app)
);

-- Что пользователь без подписки уже напечатал (для бесплатных лимитов).
-- fp — «отпечаток» документа: тот же документ можно печатать повторно без расхода лимита.
CREATE TABLE IF NOT EXISTS print_log (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app        TEXT NOT NULL,
  fp         TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, app, fp)
);
`);

module.exports = db;
