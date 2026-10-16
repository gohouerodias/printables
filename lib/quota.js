'use strict';
const db = require('./db');

// Бесплатные лимиты на один аккаунт (пока нет подписки на это приложение).
// forms: [1 человек, 2–4 человека, 5+ человек] — формы слова для текста на экране.
const FREE = {
  spravki: { kind: 'prints', limit: 2, forms: ['документ', 'документа', 'документов'] }, // 2 разных документа
  kupony: { kind: 'prints', limit: 1, forms: ['набор', 'набора', 'наборов'] }, // 1 набор (одна тема)
  rodoslovnaya: { kind: 'people', limit: 5, forms: ['человек', 'человека', 'человек'] }, // до 5 человек в древе
};

const printed = (userId, app) =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM print_log WHERE user_id = ? AND app = ?').get(userId, app).n);

function countPeople(data) {
  return data && Array.isArray(data.people) ? data.people.length : 0;
}

function savedPeople(userId, app) {
  const row = db.prepare('SELECT json FROM app_data WHERE user_id = ? AND app = ?').get(userId, app);
  if (!row) return 0;
  try {
    return countPeople(JSON.parse(row.json));
  } catch {
    return 0;
  }
}

function status(userId, app, subscribed) {
  const f = FREE[app];
  const used = f.kind === 'people' ? savedPeople(userId, app) : printed(userId, app);
  return {
    subscribed: !!subscribed,
    kind: f.kind,
    limit: f.limit,
    used,
    remaining: Math.max(0, f.limit - used),
    forms: f.forms,
  };
}

// Можно ли печатать без подписки.
// fp — «отпечаток» документа: повторная печать того же документа не тратит лимит.
function authorizePrint(userId, app, fp, people) {
  const f = FREE[app];
  if (f.kind === 'people') {
    return Number(people) <= f.limit
      ? { ok: true }
      : { ok: false, error: `В бесплатной версии — до ${f.limit} человек в древе.` };
  }
  const key = String(fp || '').slice(0, 200);
  if (!key) return { ok: false, error: 'Не удалось определить документ.' };
  if (db.prepare('SELECT 1 FROM print_log WHERE user_id = ? AND app = ? AND fp = ?').get(userId, app, key)) {
    return { ok: true };
  }
  if (printed(userId, app) >= f.limit) {
    return { ok: false, error: 'Бесплатные печати закончились.' };
  }
  db.prepare('INSERT OR IGNORE INTO print_log (user_id, app, fp, created_at) VALUES (?, ?, ?, ?)').run(
    userId, app, key, Date.now()
  );
  return { ok: true };
}

module.exports = { FREE, status, authorizePrint, countPeople };
