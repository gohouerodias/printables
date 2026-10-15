'use strict';
const crypto = require('node:crypto');
const db = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'sid';

// ---------- пароли (scrypt из стандартной библиотеки) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---------- сессии ----------
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400000;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expires };
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(res, token, expires) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(expires).toUTCString()}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// Middleware: кладёт req.user, если вход выполнен
function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  req.sessionToken = token || null;
  req.user = null;
  if (token) {
    const row = db
      .prepare(
        `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`
      )
      .get(token, Date.now());
    if (row) req.user = { id: Number(row.id), email: row.email };
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  next();
}

// ---------- подписки ----------
const APPS = {
  spravki: { title: 'Справки о важном', file: 'documents.html' },
  kupony: { title: 'Книжка купонов', file: 'coupons.html' },
  rodoslovnaya: { title: 'Родословная', file: 'tree.html' },
};

function hasActiveSub(userId, app) {
  const row = db.prepare('SELECT paid_until FROM subscriptions WHERE user_id = ? AND app = ?').get(userId, app);
  return !!row && Number(row.paid_until) > Date.now();
}

// Простейшее ограничение частоты запросов по IP (в памяти)
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) {
      entry.count = 0;
      entry.reset = now + windowMs;
    }
    entry.count += 1;
    hits.set(key, entry);
    if (entry.count > max) return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
    next();
  };
}

module.exports = {
  APPS,
  hashPassword,
  verifyPassword,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  loadUser,
  requireUser,
  hasActiveSub,
  rateLimit,
};
