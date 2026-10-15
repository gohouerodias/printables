'use strict';
// Автотест: npm test
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'printables-test-'));
process.env.DEV_FREE_ACCESS = '1';
process.env.BASE_URL = 'http://localhost';

const app = require('./server');
const db = require('./lib/db');
const billing = require('./lib/billing');

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body, opts = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set && !opts.keepCookie) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, loc: res.headers.get('location') };
  };
  let n = 0;
  const ok = (name) => console.log(`  ✓ ${name}`, ++n && '');

  // --- без входа ---
  let r = await call('GET', '/app/spravki');
  assert.equal(r.status, 302); assert.match(r.loc, /^\/login\.html/); ok('приложение закрыто без входа');
  r = await call('GET', '/api/data/spravki');
  assert.equal(r.status, 401); ok('данные закрыты без входа');

  // --- регистрация ---
  r = await call('POST', '/api/signup', { email: 'bad', password: '12345678' });
  assert.equal(r.status, 400); ok('плохой email отклонён');
  r = await call('POST', '/api/signup', { email: 'a@b.ru', password: 'short' });
  assert.equal(r.status, 400); ok('короткий пароль отклонён');
  r = await call('POST', '/api/signup', { email: 'User@Example.ru', password: 'password123' });
  assert.equal(r.status, 200); ok('регистрация');
  r = await call('POST', '/api/signup', { email: 'user@example.ru', password: 'password123' });
  assert.equal(r.status, 409); ok('повторный email отклонён');

  // --- без подписки ---
  r = await call('GET', '/app/spravki');
  assert.equal(r.status, 302); assert.match(r.loc, /account\.html\?need=spravki/); ok('без подписки — редирект в кабинет');
  r = await call('PUT', '/api/data/spravki', { x: 1 });
  assert.equal(r.status, 402); ok('сохранение без подписки закрыто (402)');

  // --- подписка на ОДНО приложение не открывает другие ---
  r = await call('POST', '/api/subscribe', { app: 'spravki' });
  assert.equal(r.status, 200);
  r = await call('GET', '/app/spravki');
  assert.equal(r.status, 200); assert.match(r.text, /Справки о важном/); ok('после подписки приложение открывается');
  r = await call('GET', '/app/kupony');
  assert.equal(r.status, 302); ok('другое приложение остаётся закрытым');
  r = await call('POST', '/api/subscribe', { app: 'nope' });
  assert.equal(r.status, 400); ok('неизвестное приложение отклонено');

  // --- данные ---
  r = await call('PUT', '/api/data/spravki', { state: { who: 'Иван' } });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/data/spravki');
  assert.deepEqual(r.json, { state: { who: 'Иван' } }); ok('данные сохраняются и читаются');

  // --- /api/me ---
  r = await call('GET', '/api/me');
  const a = r.json.apps.find((x) => x.slug === 'spravki');
  assert.equal(a.active, true); assert.equal(r.json.apps.find((x) => x.slug === 'kupony').active, false); ok('/api/me показывает подписки');

  // --- вход / выход ---
  await call('POST', '/api/logout');
  r = await call('GET', '/app/spravki');
  assert.equal(r.status, 302); ok('после выхода доступа нет');
  r = await call('POST', '/api/login', { email: 'user@example.ru', password: 'wrong-pass' });
  assert.equal(r.status, 401); ok('неверный пароль отклонён');
  r = await call('POST', '/api/login', { email: 'user@example.ru', password: 'password123' });
  assert.equal(r.status, 200); ok('вход');

  // --- биллинг: продление платежом ЮKassa (без сети, имитация ответа API) ---
  const uid = Number(db.prepare('SELECT id FROM users').get().id);
  db.prepare('INSERT INTO payments (id, user_id, app, status, amount, created_at) VALUES (?,?,?,?,?,?)')
    .run('pay-1', uid, 'kupony', 'pending', '199.00', Date.now());
  const fake = { id: 'pay-1', status: 'succeeded', paid: true, payment_method: { id: 'pm-1', saved: true } };
  assert.equal(billing.applySucceededPayment(fake), true);
  let sub = db.prepare('SELECT * FROM subscriptions WHERE user_id=? AND app=?').get(uid, 'kupony');
  const days = (Number(sub.paid_until) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days <= 30); assert.equal(sub.payment_method_id, 'pm-1'); ok('успешный платёж даёт 30 дней + сохраняет карту');
  billing.applySucceededPayment(fake); // повторный вебхук
  const sub2 = db.prepare('SELECT * FROM subscriptions WHERE user_id=? AND app=?').get(uid, 'kupony');
  assert.equal(Number(sub2.paid_until), Number(sub.paid_until)); ok('повторный вебхук не продлевает дважды');
  assert.equal(billing.applySucceededPayment({ id: 'unknown', status: 'succeeded', paid: true }), false); ok('чужой платёж игнорируется');
  r = await call('GET', '/app/kupony');
  assert.equal(r.status, 200); ok('приложение «Купоны» открылось после оплаты');

  r = await call('POST', '/api/cancel', { app: 'kupony' });
  sub = db.prepare('SELECT auto_renew FROM subscriptions WHERE user_id=? AND app=?').get(uid, 'kupony');
  assert.equal(Number(sub.auto_renew), 0); ok('автопродление отключается');

  // --- истёкшая подписка ---
  db.prepare("UPDATE subscriptions SET paid_until = ? WHERE app = 'spravki'").run(Date.now() - 1000);
  r = await call('GET', '/app/spravki');
  assert.equal(r.status, 302); ok('истёкшая подписка закрывает доступ');

  // --- раскладка дерева ---
  const html = fs.readFileSync(path.join(__dirname, 'apps', 'tree.html'), 'utf8');
  const code = html.slice(html.indexOf('const CW = 160'), html.indexOf('function drawTree'));
  const birth = (p) => { const m = /\d{4}/.exec(p.years || ''); return m ? Number(m[0]) : 9999; };
  const layout = new Function('birth', code + '; return layout;')(birth);
  const P = (id, years, extra) => ({ id, name: id, years, title: '', father: '', mother: '', spouse: '', ...extra });
  const people = [
    P('gf', '1948', { spouse: 'gm' }), P('gm', '1951', { spouse: 'gf' }),
    P('dad', '1975', { father: 'gf', mother: 'gm', spouse: 'mom' }), P('mom', '1977', { spouse: 'dad' }),
    P('aunt', '1979', { father: 'gf', mother: 'gm' }),
    P('me', '2002', { father: 'dad', mother: 'mom' }), P('sis', '2006', { father: 'dad', mother: 'mom' }),
    P('cousin', '2004', { mother: 'aunt' }),
  ];
  const L = layout(people);
  assert.equal(L.units.length, 6); // 2 пары + тётя + 3 внука
  const cards = L.units.flatMap((u) => u.members.map((m, i) => ({ id: m.id, x: u.x + i * 186, y: u.y })));
  assert.equal(cards.length, 8);
  // карточки одного поколения не перекрываются
  const rows = {};
  cards.forEach((c) => (rows[c.y] ||= []).push(c));
  for (const row of Object.values(rows)) {
    row.sort((p, q) => p.x - q.x);
    for (let i = 1; i < row.length; i++) assert.ok(row[i].x - row[i - 1].x >= 160, 'карточки перекрываются');
  }
  assert.equal(Object.keys(rows).length, 3); assert.ok(L.width > 0 && L.height > 0); ok('раскладка дерева: 3 поколения, без перекрытий');
  // цикл не вешает программу
  const cyc = layout([P('a', '1', { father: 'b' }), P('b', '2', { father: 'a' })]);
  assert.equal(cyc.units.length, 2); ok('цикл родства не зависает');

  server.close();
  console.log(`\nВсе проверки пройдены (${n}).`);
  process.exit(0);
})().catch((e) => { console.error('\n✗ ТЕСТ НЕ ПРОЙДЕН:', e); process.exit(1); });
