'use strict';
const db = require('./db');
const yk = require('./yookassa');
const { APPS } = require('./auth');

const PRICE = process.env.PRICE_RUB || '199.00';
const PERIOD_MS = 30 * 86400000;

// Применяет успешный платёж к подписке ровно один раз
function applySucceededPayment(payment) {
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
  if (!row) return false; // чужой/неизвестный платёж
  if (Number(row.applied) === 1) return true;
  if (payment.status !== 'succeeded' || payment.paid !== true) return false;

  const now = Date.now();
  const sub = db.prepare('SELECT paid_until FROM subscriptions WHERE user_id = ? AND app = ?').get(row.user_id, row.app);
  const base = sub && Number(sub.paid_until) > now ? Number(sub.paid_until) : now;
  const newUntil = base + PERIOD_MS;
  const methodId = payment.payment_method && payment.payment_method.saved ? payment.payment_method.id : null;

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO subscriptions (user_id, app, paid_until, auto_renew, payment_method_id)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(user_id, app) DO UPDATE SET
         paid_until = excluded.paid_until,
         payment_method_id = COALESCE(excluded.payment_method_id, subscriptions.payment_method_id)`
    ).run(row.user_id, row.app, newUntil, methodId);
    db.prepare("UPDATE payments SET status = 'succeeded', applied = 1 WHERE id = ?").run(payment.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}

function markCanceled(payment) {
  db.prepare("UPDATE payments SET status = 'canceled' WHERE id = ? AND applied = 0").run(payment.id);
}

// Синхронизация одного платежа с ЮKassa (вебхук и возврат со страницы оплаты)
async function syncPayment(paymentId) {
  const payment = await yk.getPayment(paymentId);
  if (payment.status === 'succeeded') applySucceededPayment(payment);
  else if (payment.status === 'canceled') markCanceled(payment);
  return payment.status;
}

async function startFirstPayment(user, app, returnUrl) {
  const title = APPS[app].title;
  const payment = await yk.createFirstPayment({ user, app, title, amount: PRICE, returnUrl });
  db.prepare('INSERT INTO payments (id, user_id, app, status, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    payment.id, user.id, app, payment.status, PRICE, Date.now()
  );
  return payment.confirmation && payment.confirmation.confirmation_url;
}

// Раз в час: продлеваем подписки, которые истекают в течение суток
async function runRenewals() {
  if (!yk.configured()) return;
  const now = Date.now();
  const due = db
    .prepare(
      `SELECT s.user_id, s.app, s.payment_method_id, s.paid_until, u.email
       FROM subscriptions s JOIN users u ON u.id = s.user_id
       WHERE s.auto_renew = 1 AND s.payment_method_id IS NOT NULL
         AND s.paid_until < ? AND s.last_renew_try < ?`
    )
    .all(now + 86400000, now - 12 * 3600000);

  for (const s of due) {
    if (!APPS[s.app]) continue;
    // Окно ключа идемпотентности: одна попытка на подписку в 12 часов, без двойных списаний
    const bucket = Math.floor(now / (12 * 3600000));
    const key = `renew-${s.user_id}-${s.app}-${bucket}`;
    try {
      db.prepare('UPDATE subscriptions SET last_renew_try = ? WHERE user_id = ? AND app = ?').run(now, s.user_id, s.app);
      const payment = await yk.createRecurringPayment({
        user: { id: Number(s.user_id), email: s.email },
        app: s.app,
        title: APPS[s.app].title,
        amount: PRICE,
        paymentMethodId: s.payment_method_id,
        idempotenceKey: key,
      });
      db.prepare(
        'INSERT OR IGNORE INTO payments (id, user_id, app, status, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(payment.id, s.user_id, s.app, payment.status, PRICE, now);
      if (payment.status === 'succeeded') applySucceededPayment(payment);
    } catch (e) {
      console.error(`[renew] не удалось продлить ${s.app} для пользователя ${s.user_id}:`, e.message);
    }
  }
}

module.exports = { PRICE, syncPayment, startFirstPayment, runRenewals, applySucceededPayment };
