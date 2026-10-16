'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

// Мини-загрузчик .env (без отдельного пакета)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const db = require('./lib/db');
const auth = require('./lib/auth');
const billing = require('./lib/billing');
const yk = require('./lib/yookassa');
const quota = require('./lib/quota');

const { APPS } = auth;
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DEV_FREE = process.env.DEV_FREE_ACCESS === '1';

const app = express();
app.set('trust proxy', 1); // за nginx
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(auth.loadUser);

// ---------- аккаунт ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.post('/api/signup', auth.rateLimit(10, 3600000), (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: 'Введите корректный email' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Пароль — минимум 8 символов' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Этот email уже зарегистрирован' });
  }
  const info = db
    .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
    .run(email, auth.hashPassword(password), Date.now());
  const s = auth.createSession(Number(info.lastInsertRowid));
  auth.setSessionCookie(res, s.token, s.expires);
  res.json({ ok: true });
});

app.post('/api/login', auth.rateLimit(20, 900000), (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }
  const s = auth.createSession(Number(user.id));
  auth.setSessionCookie(res, s.token, s.expires);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const apps = Object.entries(APPS).map(([slug, a]) => ({ slug, title: a.title, active: false, paidUntil: null, autoRenew: false }));
  if (!req.user) return res.json({ user: null, apps, price: billing.PRICE });
  const subs = db.prepare('SELECT app, paid_until, auto_renew FROM subscriptions WHERE user_id = ?').all(req.user.id);
  for (const a of apps) {
    const s = subs.find((x) => x.app === a.slug);
    if (s && Number(s.paid_until) > 0) {
      a.paidUntil = Number(s.paid_until);
      a.active = a.paidUntil > Date.now();
      a.autoRenew = Number(s.auto_renew) === 1;
    }
  }
  for (const a of apps) a.free = a.active ? null : quota.status(req.user.id, a.slug, false);
  res.json({ user: { email: req.user.email }, apps, price: billing.PRICE });
});

// ---------- подписка и оплата ----------
app.post('/api/subscribe', auth.requireUser, async (req, res) => {
  const slug = req.body && req.body.app;
  if (!APPS[slug]) return res.status(400).json({ error: 'Неизвестное приложение' });
  try {
    if (DEV_FREE) {
      // ТОЛЬКО для локальной проверки: выдаёт 30 дней бесплатно
      const until = Date.now() + 30 * 86400000;
      db.prepare(
        `INSERT INTO subscriptions (user_id, app, paid_until, auto_renew) VALUES (?, ?, ?, 0)
         ON CONFLICT(user_id, app) DO UPDATE SET paid_until = excluded.paid_until`
      ).run(req.user.id, slug, until);
      return res.json({ url: `${BASE_URL}/account.html?paid=1` });
    }
    if (!yk.configured()) return res.status(503).json({ error: 'Оплата ещё не настроена' });
    const url = await billing.startFirstPayment(req.user, slug, `${BASE_URL}/account.html?paid=1&app=${slug}`);
    res.json({ url });
  } catch (e) {
    console.error('[subscribe]', e.message, e.details || '');
    res.status(502).json({ error: 'Не удалось создать платёж. Попробуйте позже.' });
  }
});

// Страница аккаунта после возврата с оплаты: сверяем незавершённые платежи пользователя
app.post('/api/sync', auth.requireUser, async (req, res) => {
  if (!yk.configured()) return res.json({ ok: true });
  const pending = db
    .prepare("SELECT id FROM payments WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 10")
    .all(req.user.id);
  for (const p of pending) {
    try {
      await billing.syncPayment(p.id);
    } catch (e) {
      console.error('[sync]', e.message);
    }
  }
  res.json({ ok: true });
});

// Вебхук ЮKassa. Статус не берём из тела — перепроверяем через API.
app.post('/api/yookassa/webhook', async (req, res) => {
  const obj = req.body && req.body.object;
  if (obj && obj.id && /^payment\./.test(String(req.body.event || ''))) {
    try {
      await billing.syncPayment(String(obj.id));
    } catch (e) {
      console.error('[webhook]', e.message);
      return res.status(500).end(); // ЮKassa повторит отправку
    }
  }
  res.status(200).end();
});

function setAutoRenew(value) {
  return (req, res) => {
    const slug = req.body && req.body.app;
    if (!APPS[slug]) return res.status(400).json({ error: 'Неизвестное приложение' });
    db.prepare('UPDATE subscriptions SET auto_renew = ? WHERE user_id = ? AND app = ?').run(value, req.user.id, slug);
    res.json({ ok: true });
  };
}
app.post('/api/cancel', auth.requireUser, setAutoRenew(0)); // доступ остаётся до конца оплаченного срока
app.post('/api/resume', auth.requireUser, (req, res, next) => {
  const slug = req.body && req.body.app;
  const row = db.prepare('SELECT payment_method_id FROM subscriptions WHERE user_id = ? AND app = ?').get(req.user.id, slug);
  if (!row || !row.payment_method_id) return res.status(400).json({ error: 'Для автопродления оформите подписку заново' });
  setAutoRenew(1)(req, res, next);
});

// ---------- бесплатные лимиты (без подписки) ----------
// Справки: 2 документа · Купоны: 1 набор · Родословная: до 5 человек. Цифры — в lib/quota.js
const quotaStatus = (userId, slug) => ({
  ...quota.status(userId, slug, auth.hasActiveSub(userId, slug)),
  price: parseInt(billing.PRICE, 10),
});

app.get('/api/quota/:app', auth.requireUser, (req, res) => {
  if (!APPS[req.params.app]) return res.status(404).json({ error: 'Нет такого приложения' });
  res.json(quotaStatus(req.user.id, req.params.app));
});

// Вызывается кнопкой «Печать»: у подписчика пропускает всегда, у остальных — пока не исчерпан лимит
app.post('/api/use/:app', auth.requireUser, (req, res) => {
  const slug = req.params.app;
  if (!APPS[slug]) return res.status(404).json({ error: 'Нет такого приложения' });
  if (!auth.hasActiveSub(req.user.id, slug)) {
    const body = req.body || {};
    const r = quota.authorizePrint(req.user.id, slug, body.fp, body.people);
    if (!r.ok) return res.status(402).json({ error: r.error, status: quotaStatus(req.user.id, slug) });
  }
  res.json({ ok: true, status: quotaStatus(req.user.id, slug) });
});

// ---------- данные пользователя в приложениях ----------
// Данные доступны любому вошедшему пользователю; ограничения — в quota.js
function requireApp(req, res, next) {
  const slug = req.params.app;
  if (!APPS[slug]) return res.status(404).json({ error: 'Нет такого приложения' });
  if (!req.user) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  next();
}

app.get('/api/data/:app', requireApp, (req, res) => {
  const row = db.prepare('SELECT json FROM app_data WHERE user_id = ? AND app = ?').get(req.user.id, req.params.app);
  res.type('json').send(row ? row.json : 'null');
});

app.put('/api/data/:app', requireApp, (req, res) => {
  const slug = req.params.app;
  const f = quota.FREE[slug];
  if (f.kind === 'people' && !auth.hasActiveSub(req.user.id, slug) && quota.countPeople(req.body) > f.limit) {
    return res.status(402).json({
      error: `В бесплатной версии — до ${f.limit} человек в древе.`,
      status: quotaStatus(req.user.id, slug),
    });
  }
  const json = JSON.stringify(req.body === undefined ? null : req.body);
  if (json.length > 900000) return res.status(413).json({ error: 'Слишком много данных' });
  db.prepare(
    `INSERT INTO app_data (user_id, app, json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, app) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
  ).run(req.user.id, req.params.app, json, Date.now());
  res.json({ ok: true });
});

// ---------- сами приложения: только с активной подпиской ----------
app.get('/app/:app', (req, res) => {
  const slug = req.params.app;
  if (!APPS[slug]) return res.status(404).send('Не найдено');
  if (!req.user) return res.redirect(`/login.html?next=${encodeURIComponent('/app/' + slug)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'apps', APPS[slug].file));
});

// ---------- публичные страницы ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((_req, res) => res.status(404).send('Страница не найдена'));

// Автопродление раз в час
if (require.main === module) {
  if (DEV_FREE) console.warn('⚠️  DEV_FREE_ACCESS=1: подписки выдаются бесплатно. Не включайте на боевом сервере!');
  if (!yk.configured() && !DEV_FREE) console.warn('⚠️  ЮKassa не настроена (YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY): оплата не будет работать.');
  setInterval(() => billing.runRenewals().catch((e) => console.error('[renewals]', e.message)), 3600000).unref();
  app.listen(PORT, () => console.log(`Сервер запущен: ${BASE_URL} (порт ${PORT})`));
}

module.exports = app;
