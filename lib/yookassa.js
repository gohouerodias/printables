'use strict';
// Минимальный клиент ЮKassa (https://yookassa.ru/developers/api) на встроенном fetch.
const crypto = require('node:crypto');

const API = 'https://api.yookassa.ru/v3';

function configured() {
  return !!(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY);
}

async function request(method, path, body, idempotenceKey) {
  const auth = Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };
  if (method === 'POST') headers['Idempotence-Key'] = idempotenceKey || crypto.randomUUID();
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.description || `YooKassa HTTP ${res.status}`);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

// Чек по 54-ФЗ нужен, если у вас подключена онлайн-касса ЮKassa. Самозанятые чеки формируют в «Мой налог».
function buildReceipt(email, description, amount) {
  if (process.env.YOOKASSA_RECEIPT !== '1') return undefined;
  return {
    customer: { email },
    items: [
      {
        description: description.slice(0, 128),
        quantity: '1.00',
        amount: { value: amount, currency: 'RUB' },
        vat_code: Number(process.env.YOOKASSA_VAT_CODE || 1), // 1 = без НДС
        payment_subject: 'service',
        payment_mode: 'full_payment',
      },
    ],
  };
}

// Первый платёж: пользователь платит на странице ЮKassa, карта сохраняется для автопродления
async function createFirstPayment({ user, app, title, amount, returnUrl }) {
  return request(
    'POST',
    '/payments',
    {
      amount: { value: amount, currency: 'RUB' },
      capture: true,
      save_payment_method: true,
      confirmation: { type: 'redirect', return_url: returnUrl },
      description: `${title} — подписка на 30 дней`,
      metadata: { user_id: String(user.id), app },
      receipt: buildReceipt(user.email, `${title} — подписка на 30 дней`, amount),
    },
    crypto.randomUUID()
  );
}

// Автопродление: списание с сохранённого способа оплаты, без участия пользователя
async function createRecurringPayment({ user, app, title, amount, paymentMethodId, idempotenceKey }) {
  return request(
    'POST',
    '/payments',
    {
      amount: { value: amount, currency: 'RUB' },
      capture: true,
      payment_method_id: paymentMethodId,
      description: `${title} — продление на 30 дней`,
      metadata: { user_id: String(user.id), app },
      receipt: buildReceipt(user.email, `${title} — продление на 30 дней`, amount),
    },
    idempotenceKey
  );
}

// Всегда сверяем статус с самой ЮKassa — телу вебхука не доверяем
function getPayment(id) {
  return request('GET', `/payments/${encodeURIComponent(id)}`);
}

module.exports = { configured, createFirstPayment, createRecurringPayment, getPayment };
